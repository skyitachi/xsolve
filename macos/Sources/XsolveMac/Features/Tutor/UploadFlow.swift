import AppKit
import AVFoundation
import SwiftUI

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
            Text("把「本题」框出来再送识别（拖四角调整）")
                .font(.headline)
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
                Button("✂️ 裁剪并识别") {
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
