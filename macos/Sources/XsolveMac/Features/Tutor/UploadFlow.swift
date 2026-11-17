import AppKit
import AVFoundation
import SwiftUI
import UniformTypeIdentifiers

// MARK: - 图片选择（NSOpenPanel，等价「相册选题」）

func pickImage(_ onPick: @escaping (URL) -> Void) {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.image]
    panel.allowsMultipleSelection = false
    panel.canChooseDirectories = false
    panel.message = "选择一张题目 / 解答图片"
    if panel.runModal() == .OK, let url = panel.url {
        onPick(url)
    }
}

// MARK: - 从本地图片文件进入上传流转（选择图片 / 拖拽共用）

/// 读文件 → 压成 JPEG dataURL → 交给 TutorState 按目标分流
/// （题目：进裁剪弹窗后立即识别；解答：进预览条等确认）
///
/// ⚠️ 题目**不在裁剪前缩放**：Web 端是拿原图裁剪、只把裁剪结果限到 1600（crop.js 的
/// CROP_MAX_EDGE）。先整体缩到 2000 再裁，作业本上的小字裁出来连 1600 都不到，
/// 识别质量明显掉一档 —— 这正是「手机拍的题看不清」的来源之一。
@MainActor
func ingestImageFile(_ url: URL, state: TutorState, target: TutorState.UploadTarget) {
    guard let img = NSImage(contentsOf: url) else {
        reportBadImage(url, state: state)
        return
    }
    let maxEdge = imageMaxEdge(for: target)
    guard let dataURL = ImageUtil.jpegDataURL(from: img, maxEdge: maxEdge) else {
        state.systemMsg("⚠️ 图片处理失败：\(url.lastPathComponent)")
        return
    }
    state.ingest(image: dataURL, target: target)
}

/// 题目：原图直通（4096 覆盖 iPhone 48MP 的 4032 长边，实际不缩）；
/// 解答：1280（纸面解答不需要高分辨率，与 Web 端 ANSWER_MAX_EDGE 一致）
func imageMaxEdge(for target: TutorState.UploadTarget) -> CGFloat {
    target == .problem ? 4096 : 1280
}

/// 读不出图时给**能照做**的提示。Web 端对 HEIC 单独一段说明，
/// 否则 iPhone 用户只会看到「图片处理失败」而无从下手。
@MainActor
func reportBadImage(_ url: URL, state: TutorState) {
    let ext = url.pathExtension.lowercased()
    let imageExts: Set<String> = ["png", "jpg", "jpeg", "heic", "heif", "gif", "bmp",
                                  "tif", "tiff", "webp", "avif"]
    if ext == "heic" || ext == "heif" {
        state.systemMsg("⚠️ 这张 HEIC 图读不出来。iPhone 默认存 HEIC，可在 设置 → 相机 → 格式 改成「兼容性最佳」，或先在相册里截图再上传。")
    } else if imageExts.contains(ext) {
        state.systemMsg("⚠️ 图片解码失败：\(url.lastPathComponent)")
    } else {
        // 与 Web 端 setupDropZone 的「⚠️ 请拖入图片文件」一致
        state.systemMsg("⚠️ 请拖入图片文件")
    }
}

// MARK: - 拖拽入图（与 Web 端 upload.js 的 setupDropZone 一致）
//
// Web 版给三块面板各挂了一个投放区：题目区默认「题目」、做题区与 AI 区默认「解答」，
// **按住 Shift 反转**；原生版沿用同一套语义，别自己发明。

extension TutorState.UploadTarget {
    /// 按住 Shift 时的目标（题目 ↔ 解答）
    var flipped: TutorState.UploadTarget { self == .problem ? .answer : .problem }

    /// Web 端 upload.js 的 label 文案
    var dropLabel: String {
        self == .problem ? "题目图片（按住 Shift 改为解答）" : "我的解答（按住 Shift 改为题目）"
    }
}

/// 当前鼠标停在哪个投放区 —— 粘贴图片时按它决定目标（Web 端按焦点判断）
@MainActor
final class DropZoneHover: ObservableObject {
    static let shared = DropZoneHover()
    @Published var target: TutorState.UploadTarget?
}

/// 把拖进来/粘贴进来的东西变成 `TutorState.ingest` 的输入。
///
/// 分两条路走：Finder 拖文件给的是 `public.file-url`，从浏览器拖图片常常只给
/// `public.tiff` / `public.png` 的原始数据 —— 只认其中一种的话，
/// 「拖文件能进、拖截图不能进」这种半残体验很容易被当成坏了。
enum ImageDropHandler {
    static let supported: [UTType] = [.fileURL, .image, .png, .jpeg, .tiff, .heic]

    /// 返回值只表示「我接下了这个拖拽」；真正的读取是异步的
    @MainActor
    static func accept(_ providers: [NSItemProvider],
                       state: TutorState,
                       target: TutorState.UploadTarget) -> Bool {
        guard let p = providers.first else { return false }

        if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            p.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                let url: URL? = {
                    if let u = item as? URL { return u }
                    if let d = item as? Data { return URL(dataRepresentation: d, relativeTo: nil) }
                    if let s = item as? String { return URL(string: s) }
                    return nil
                }()
                guard let url else { return }
                Task { @MainActor in ingestImageFile(url, state: state, target: target) }
            }
            return true
        }

        for type in [UTType.png, .jpeg, .tiff, .heic, .image]
        where p.hasItemConformingToTypeIdentifier(type.identifier) {
            p.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
                guard let data, let img = NSImage(data: data) else {
                    // 别静默 return：Web 端拖坏图会给「⚠️ 请拖入图片文件」，原生也得有反馈
                    Task { @MainActor in state.systemMsg("⚠️ 图片解码失败，请换一张试试") }
                    return
                }
                let maxEdge = imageMaxEdge(for: target)
                guard let dataURL = ImageUtil.jpegDataURL(from: img, maxEdge: maxEdge) else {
                    Task { @MainActor in state.systemMsg("⚠️ 图片处理失败") }
                    return
                }
                Task { @MainActor in state.ingest(image: dataURL, target: target) }
            }
            return true
        }
        return false
    }
}

/// 拖拽悬停时的提示层（与 Web 端 .drop-overlay 同款：整块淡紫底 + 2px 虚线 + 居中加粗文字）
struct DropHintOverlay: View {
    let hint: String

    var body: some View {
        ZStack {
            Color.brand.opacity(0.10)
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.brand, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
            Text(hint)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color.brand)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16)
        }
        .allowsHitTesting(false)
    }
}

/// 给任意区域挂「把图片拖进来」。拖拽悬停时铺一层品牌色虚线框 + 文字，
/// 否则用户不知道这块能接图（尤其题目区大片空白处）。
struct ImageDropModifier: ViewModifier {
    @ObservedObject var state: TutorState
    let target: TutorState.UploadTarget
    @State private var isTargeted = false

    /// 松手那一刻读修饰键：SwiftUI 的 onDrop 不告诉我们按了什么键
    private var effectiveTarget: TutorState.UploadTarget {
        NSEvent.modifierFlags.contains(.shift) ? target.flipped : target
    }

    func body(content: Content) -> some View {
        content
            .onDrop(of: ImageDropHandler.supported, isTargeted: $isTargeted) { providers in
                ImageDropHandler.accept(providers, state: state, target: effectiveTarget)
            }
            .onHover { inside in
                if inside { DropZoneHover.shared.target = target }
                else if DropZoneHover.shared.target == target { DropZoneHover.shared.target = nil }
            }
            .overlay {
                if isTargeted {
                    DropHintOverlay(hint: "松开鼠标：作为「\(target.dropLabel)」上传")
                }
            }
            .animation(.easeOut(duration: 0.12), value: isTargeted)
    }
}

extension View {
    func imageDrop(state: TutorState, target: TutorState.UploadTarget) -> some View {
        modifier(ImageDropModifier(state: state, target: target))
    }
}

// MARK: - 粘贴图片（与 Web 端 paste 处理一致）
//
// 截图后 Cmd+V 直接进；目标按「鼠标停在哪块面板」决定（Web 用焦点判断，
// 原生没有等价的焦点概念，用悬停既直观又不会误伤输入框里的文本粘贴）。
struct ImagePasteModifier: ViewModifier {
    @ObservedObject var state: TutorState
    @State private var monitor: Any?

    func body(content: Content) -> some View {
        content
            .onAppear {
                guard monitor == nil else { return }
                monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                    handle(event) ? nil : event
                }
            }
            .onDisappear {
                if let m = monitor { NSEvent.removeMonitor(m) }
                monitor = nil
            }
    }

    /// 返回 true = 已消费（不再传给文本框等第一响应者）
    private func handle(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags == .command,
              event.charactersIgnoringModifiers?.lowercased() == "v" else { return false }
        // 剪贴板里没有图片就放行：别抢掉普通文本的 Cmd+V
        guard let img = NSImage(pasteboard: .general) else { return false }

        let target = DropZoneHover.shared.target ?? .answer
        let maxEdge: CGFloat = target == .problem ? 2000 : 1280
        guard let dataURL = ImageUtil.jpegDataURL(from: img, maxEdge: maxEdge) else {
            state.errorMsg("图片处理失败：剪贴板内容读不出来")
            return true
        }
        state.ingest(image: dataURL, target: target)
        return true
    }
}

extension View {
    /// 挂在 TutorView 根视图上一次即可（Cmd+V 是全局的）
    func imagePaste(state: TutorState) -> some View {
        modifier(ImagePasteModifier(state: state))
    }
}


// MARK: - 相机窗口（「拍题」：macOS 上以 Continuity Camera / 内置摄像头实现）

final class CameraWindow: NSObject, AVCapturePhotoCaptureDelegate {
    static let shared = CameraWindow()
    private var session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private var onShot: ((NSImage) -> Void)?
    private var window: NSWindow?

    func show(_ onShot: @escaping (NSImage) -> Void) {
        self.onShot = onShot
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            start()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { ok in
                DispatchQueue.main.async {
                    if ok { self.start() } else {
                        self.onShot = nil
                        Self.noCameraAlert("相机权限被拒绝，请在 系统设置 → 隐私与安全性 → 相机 中允许本应用。")
                    }
                }
            }
        default:
            Self.noCameraAlert("相机权限被拒绝，请在 系统设置 → 隐私与安全性 → 相机 中允许本应用。")
        }
    }

    private static func noCameraAlert(_ msg: String) {
        let a = NSAlert()
        a.messageText = "无法使用相机"
        a.informativeText = msg
        a.runModal()
    }

    private func start() {
        session.beginConfiguration()
        session.sessionPreset = .photo
        // 已在运行（重复打开）时直接复用
        if session.inputs.isEmpty {
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .unspecified)
                    ?? AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: .unspecified).devices.first,
                  let input = try? AVCaptureDeviceInput(device: device) else {
                session.commitConfiguration()
                Self.noCameraAlert("未检测到摄像头。iPhone 靠近 Mac 时可使用「连续互通相机」，或在手机上拍好后用「选择图片」上传。")
                return
            }
            if session.canAddInput(input) { session.addInput(input) }
            if session.canAddOutput(output) { session.addOutput(output) }
        }
        session.commitConfiguration()

        let host = CameraPreviewHost(session: session) { [weak self] in
            self?.capture()
        } onCancel: { [weak self] in
            self?.close()
        }
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 520),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "📷 拍题（连续互通相机 / 内置摄像头）"
        w.contentView = host
        w.center()
        w.makeKeyAndOrderFront(nil)
        window = w
        if !session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
        }
    }

    private func capture() {
        let settings = AVCapturePhotoSettings()
        output.capturePhoto(with: settings, delegate: self)
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        guard error == nil, let data = photo.fileDataRepresentation(),
              let img = NSImage(data: data) else {
            DispatchQueue.main.async { Self.noCameraAlert("拍照失败：\(error?.localizedDescription ?? "未知错误")") }
            return
        }
        DispatchQueue.main.async {
            let cb = self.onShot
            self.close()
            cb?(img)
        }
    }

    private func close() {
        DispatchQueue.global(qos: .userInitiated).async { [session] in
            if session.isRunning { session.stopRunning() }
        }
        window?.close()
        window = nil
        onShot = nil
    }
}

/// 相机预览 + 快门
final class CameraPreviewHost: NSView {
    private let preview = AVCaptureVideoPreviewLayer()
    private let onShot: () -> Void
    private let onCancel: () -> Void

    init(session: AVCaptureSession, onShot: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.onShot = onShot
        self.onCancel = onCancel
        super.init(frame: .zero)
        wantsLayer = true
        preview.session = session
        preview.videoGravity = .resizeAspectFill
        layer?.addSublayer(preview)

        let shutter = ClosureButton(title: "📷 拍照", onClick: onShot)
        shutter.bezelStyle = .regularSquare
        shutter.keyEquivalent = "\r"
        shutter.translatesAutoresizingMaskIntoConstraints = false
        addSubview(shutter)

        let cancel = ClosureButton(title: "取消", onClick: onCancel)
        cancel.bezelStyle = .regularSquare
        cancel.translatesAutoresizingMaskIntoConstraints = false
        cancel.keyEquivalent = "\u{1b}"
        addSubview(cancel)

        NSLayoutConstraint.activate([
            shutter.centerXAnchor.constraint(equalTo: centerXAnchor),
            shutter.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -16),
            cancel.leftAnchor.constraint(equalTo: shutter.rightAnchor, constant: 16),
            cancel.centerYAnchor.constraint(equalTo: shutter.centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        preview.frame = bounds
        CATransaction.commit()
    }
}

/// 闭包式 NSButton（AppKit 没有 onAction）
final class ClosureButton: NSButton {
    private let onClick: () -> Void

    init(title: String, onClick: @escaping () -> Void) {
        self.onClick = onClick
        super.init(frame: .zero)
        self.title = title
        self.target = self
        self.action = #selector(fire)
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc private func fire() { onClick() }
}

// MARK: - 裁剪对话框（crop.js：拖出裁剪框 → 输出 JPEG dataURL）

struct CropDialog: View {
    let imageDataURL: String
    let onDone: (String) -> Void
    let onCancel: () -> Void

    @State private var rect = CropRect()
    @State private var draggingCorner: Corner? = nil

    enum Corner: String, CaseIterable {
        case tl = "↖", tr = "↗", bl = "↙", br = "↘"
    }

    var body: some View {
        VStack(spacing: 12) {
            // 与 Web 端 crop.js 的头部文案一致
            VStack(spacing: 4) {
                Text("框出这一道题").font(.headline)
                Text("拖动方框可移动，拖四角可缩放；整页就点「用全图」")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let img = ImageUtil.image(fromDataURL: imageDataURL) {
                GeometryReader { geo in
                    ZStack {
                        Image(nsImage: img)
                            .resizable()
                            .scaledToFit()
                            .frame(width: geo.size.width, height: geo.size.height)
                        // 裁剪框（归一化坐标）
                        CropOverlay(rect: rect)
                            .fill(Color.brand.opacity(0.08))
                            .border(Color.brand, width: 1.5)
                        ForEach(Corner.allCases, id: \.self) { c in
                            Circle()
                                .fill(Color.brand)
                                .frame(width: 14, height: 14)
                                .overlay(Circle().stroke(.white, lineWidth: 2))
                                .position(cornerPos(c, in: geo.size))
                                .gesture(
                                    DragGesture(minimumDistance: 1).onChanged { g in
                                        moveCorner(c, to: g.location, in: geo.size)
                                    }
                                )
                        }
                        // 整体拖动
                        RoundedRectangle(cornerRadius: 0)
                            .fill(Color.clear)
                            .frame(width: geo.size.width * rect.w, height: geo.size.height * rect.h)
                            .position(x: geo.size.width * (rect.x + rect.w / 2),
                                      y: geo.size.height * (rect.y + rect.h / 2))
                            .gesture(
                                DragGesture(minimumDistance: 1).onChanged { g in
                                    rect.x = clamp(rect.x + Double(g.translation.width / max(geo.size.width, 1)), 0, 1 - rect.w)
                                    rect.y = clamp(rect.y + Double(g.translation.height / max(geo.size.height, 1)), 0, 1 - rect.h)
                                }
                            )
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Text("图片读取失败").foregroundStyle(.red)
            }

            HStack {
                Button("取消") { onCancel() }
                Spacer()
                // 与 Web 端一致：整页就用全图，不必手动拉到边
                Button("用全图") {
                    if let img = ImageUtil.image(fromDataURL: imageDataURL),
                       let out = Cropper.crop(image: img,
                                              rect: CropRect(x: 0, y: 0, w: 1, h: 1)) {
                        onDone(out)
                    }
                }
                Button("确认裁剪") {
                    if let img = ImageUtil.image(fromDataURL: imageDataURL),
                       let out = Cropper.crop(image: img, rect: rect) {
                        onDone(out)
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(16)
        .frame(width: 620, height: 560)
    }

    private func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(max(v, lo), max(hi, lo)) }

    private func cornerPos(_ c: Corner, in size: CGSize) -> CGPoint {
        let x = c == .tl || c == .bl ? rect.x : rect.x + rect.w
        let y = c == .tl || c == .tr ? rect.y : rect.y + rect.h
        return CGPoint(x: size.width * x, y: size.height * y)
    }

    private func moveCorner(_ c: Corner, to p: CGPoint, in size: CGSize) {
        let nx = clamp(Double(p.x / max(size.width, 1)), 0, 1)
        let ny = clamp(Double(p.y / max(size.height, 1)), 0, 1)
        switch c {
        case .tl: rect.x = min(nx, rect.x + rect.w - 0.05); rect.y = min(ny, rect.y + rect.h - 0.05)
        case .tr: rect.w = max(0.05, nx - rect.x); rect.y = min(ny, rect.y + rect.h - 0.05)
        case .bl: rect.x = min(nx, rect.x + rect.w - 0.05); rect.h = max(0.05, ny - rect.y)
        case .br: rect.w = max(0.05, nx - rect.x); rect.h = max(0.05, ny - rect.y)
        }
    }
}

struct CropOverlay: Shape {
    let rect: CropRect
    func path(in bounds: CGRect) -> Path {
        Path(CGRect(x: bounds.width * rect.x, y: bounds.height * rect.y,
                    width: bounds.width * rect.w, height: bounds.height * rect.h))
    }
}
