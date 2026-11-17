import AppKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: - 拖拽入图探针
//
// 用法：`swift run XsolveMac --uidrop`（结果写 /tmp/xsolve-uidrop.log，跑完自动退出）
//
// 拖拽在自动化里很难真模拟，但它真正的风险不在手势，而在「拖进来的东西怎么变成图片」：
// Finder 拖文件给的是 public.file-url，浏览器拖图只给 public.tiff/png 的原始数据，
// 只认一种就会出现「拖文件能进、拖截图不能进」。这里直接构造 NSItemProvider
// 走一遍 ImageDropHandler，把两条路和「拖错的类型」都验掉。

enum DropProbe {
    static var active: Bool { CommandLine.arguments.contains("--uidrop") }

    private static let logURL = URL(fileURLWithPath: "/tmp/xsolve-uidrop.log")

    private static func log(_ s: String) {
        let line = s + "\n"
        if let h = try? FileHandle(forWritingTo: logURL) {
            h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close()
        } else {
            try? line.write(to: logURL, atomically: true, encoding: .utf8)
        }
    }

    private static var failures = 0
    private static func check(_ name: String, _ ok: Bool, _ detail: String) {
        if ok {
            log("  ✓ \(name) — \(detail)")
        } else {
            failures += 1
            log("  ✗ \(name) — \(detail)")
        }
    }

    @MainActor
    static func runAndExit() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        log("==> 拖拽入图探针")

        let dir = URL(fileURLWithPath: "/tmp/xsolve-drop")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // 造一张能看出内容的图：白底 + 左上黑框（后面的缩略图/方向检查也用得上）
        let img = NSImage(size: NSSize(width: 400, height: 300))
        img.lockFocus()
        NSColor.white.setFill()
        NSRect(x: 0, y: 0, width: 400, height: 300).fill()
        NSColor.black.setFill()
        NSRect(x: 40, y: 180, width: 160, height: 80).fill()
        img.unlockFocus()
        let pngURL = dir.appendingPathComponent("题目.png")
        if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: pngURL)
        }
        check("测试图片已生成", FileManager.default.fileExists(atPath: pngURL.path), pngURL.path)

        // 1) Finder 拖文件：public.file-url
        let s1 = TutorState()
        if let provider = NSItemProvider(contentsOf: pngURL) {
            let accepted = ImageDropHandler.accept([provider], state: s1, target: .problem)
            check("文件拖拽被接收", accepted, "accept() = \(accepted)")
            spin(0.8)
            let len = s1.cropSource?.count ?? 0
            check("文件拖拽 → 进入题目裁剪流程", len > 100,
                  "cropSource = \(len) 字符（题目固定走「裁剪后再识别」）")
            if let src = s1.cropSource {
                check("落地的 dataURL 是 JPEG", src.hasPrefix("data:image/jpeg;base64,"),
                      String(src.prefix(30)))
            }
        } else {
            check("文件拖拽被接收", false, "NSItemProvider(contentsOf:) 返回 nil")
        }

        // 2) 浏览器/截图拖图片数据：只给 public.png，没有 file-url
        let s2 = TutorState()
        if let data = try? Data(contentsOf: pngURL) {
            let provider = NSItemProvider(item: data as NSData, typeIdentifier: UTType.png.identifier)
            let accepted = ImageDropHandler.accept([provider], state: s2, target: .answer)
            check("图片数据拖拽被接收", accepted, "accept() = \(accepted)")
            spin(0.8)
            check("图片数据拖拽 → 进入解答预览", s2.pendingUpload != nil,
                  s2.pendingUpload.map { "mediaType=\($0.mediaType)" } ?? "pendingUpload 仍为 nil")
        } else {
            check("图片数据拖拽被接收", false, "读不出测试 PNG")
        }

        // 3) 拖了非图片：必须明确报错，而不是静默无反应。
        //    注意提示走 systemMsg（Web 端是 addSystemMsg 的系统气泡，不是红色错误条），
        //    文案也必须和 Web 的「⚠️ 请拖入图片文件」一字不差。
        let s3 = TutorState()
        let txt = dir.appendingPathComponent("说明.txt")
        try? "这不是图片".write(to: txt, atomically: true, encoding: .utf8)
        if let provider = NSItemProvider(contentsOf: txt) {
            let accepted = ImageDropHandler.accept([provider], state: s3, target: .problem)
            spin(0.6)
            let hints = s3.entries.compactMap { e -> String? in
                if case .system(let t) = e.kind { return t } else { return nil }
            }
            let hasHint = hints.contains { $0.contains("请拖入图片文件") }
            check("非图片被拒且给出提示", accepted && hasHint && s3.cropSource == nil,
                  "accept=\(accepted), 提示=\(hints.last ?? "无"), cropSource=\(s3.cropSource == nil ? "nil" : "有值")")
        }

        // 4) 空 provider 列表不能崩、也不能假装接下
        check("空拖拽返回 false", !ImageDropHandler.accept([], state: TutorState(), target: .problem),
              "accept([]) = false")

        // 5) 与 Web 端 upload.js 的语义对齐：Shift 反转目标 + 遮罩文案
        check("Shift 反转：题目 → 解答", TutorState.UploadTarget.problem.flipped == .answer,
              "problem.flipped = \(TutorState.UploadTarget.problem.flipped)")
        check("Shift 反转：解答 → 题目", TutorState.UploadTarget.answer.flipped == .problem,
              "answer.flipped = \(TutorState.UploadTarget.answer.flipped)")
        check("遮罩文案与 Web 一致",
              TutorState.UploadTarget.problem.dropLabel == "题目图片（按住 Shift 改为解答）"
              && TutorState.UploadTarget.answer.dropLabel == "我的解答（按住 Shift 改为题目）",
              "problem=「\(TutorState.UploadTarget.problem.dropLabel)」answer=「\(TutorState.UploadTarget.answer.dropLabel)」")

        // 6) 压缩尺度与附言语义（功能对齐，不只是长得像）
        check("题目走原图直通（不预缩放）", imageMaxEdge(for: .problem) >= 4000,
              "problem maxEdge = \(Int(imageMaxEdge(for: .problem)))（裁剪输出仍限 1600）")
        check("解答限 1280（Web ANSWER_MAX_EDGE）", imageMaxEdge(for: .answer) == 1280,
              "answer maxEdge = \(Int(imageMaxEdge(for: .answer)))")
        let empty = TutorState.pendingUploadPrompt(draft: "   ")
        let typed = TutorState.pendingUploadPrompt(draft: "  这步为什么要配方？ ")
        check("附言留空 → 用默认话术",
              empty.caption.isEmpty && empty.prompt == TutorState.answerDefaultPrompt,
              "prompt =「\(empty.prompt.prefix(18))…」")
        check("附言有字 → 原样当 prompt 并去掉首尾空白",
              typed.prompt == "这步为什么要配方？" && typed.caption == typed.prompt,
              "prompt =「\(typed.prompt)」")

        // 7) 确认裁剪后弹窗必须关掉。
        //    sheet 的 isPresented 绑的是 `cropSource != nil`，只发识别请求不清标记的话，
        //    模态弹窗会一直盖在窗口上 —— 整个窗口都点不动，看起来就是「点了没反应」。
        let s4 = TutorState()
        let croppedURL = ImageUtil.jpegDataURL(from: img, maxEdge: 400) ?? ""
        s4.cropSource = croppedURL
        check("确认裁剪前处于弹窗态", s4.cropSource != nil, "cropSource 有值")
        s4.confirmCrop(croppedURL)
        check("确认裁剪后弹窗关闭（cropSource 清空）", s4.cropSource == nil,
              "cropSource = \(s4.cropSource == nil ? "nil" : "有值")")
        let uploadMsg = s4.entries.first { e -> Bool in
            if case .user(let t, let img) = e.kind { return t.contains("上传题目图片") && img != nil }
            return false
        }
        // 日志里只打长度：base64 全文会把日志刷成几万字符
        let firstEntry: String = {
            guard let e = s4.entries.first else { return "无" }
            if case .user(let t, let img) = e.kind {
                return "user「\(t)」image=\(img?.count ?? 0) 字符"
            }
            return "非 user"
        }()
        check("确认裁剪后对话里出现带图的上传消息", uploadMsg != nil,
              "entries = \(s4.entries.count) 条，首条 = \(firstEntry)")

        // 裁剪结果解析失败时也必须关窗：否则用户被永久卡在模态弹窗里
        let s5 = TutorState()
        s5.cropSource = croppedURL
        s5.confirmCrop("不是合法 dataURL")
        check("裁剪结果异常时仍关窗", s5.cropSource == nil,
              "cropSource = \(s5.cropSource == nil ? "nil" : "有值")")

        // 8) 端到端：真的把 sheet 弹出来再关。上面几条只看状态标记，
        //    这条看 SwiftUI 真正挂没挂 sheet（显隐完全由 cropPresented 决定）。
        let s6 = TutorState()
        s6.cropSource = croppedURL
        // ⚠️ 必须用 @ObservedObject 的宿主：`.sheet(isPresented:)` 只有宿主重算 body
        //    才会重读绑定值。真实 TutorView 就是 @ObservedObject，直接拿
        //    state.cropPresented 当 rootView 测会测出一个不存在的 bug。
        let host = NSHostingView(rootView: AnyView(SheetHost(state: s6)))
        let sheetWin = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 300),
                                styleMask: [.titled], backing: .buffered, defer: false)
        sheetWin.contentView = host
        sheetWin.orderFront(nil)
        spin(1.4)
        let opened = sheetWin.attachedSheet != nil
        s6.confirmCrop(croppedURL)
        spin(1.4)
        let closed = sheetWin.attachedSheet == nil
        check("裁剪弹窗会随 cropSource 弹出", opened,
              "attachedSheet = \(opened ? "有" : "无，离屏窗口可能不呈现 sheet")")
        check("确认裁剪后弹窗真的消失", closed,
              "attachedSheet = \(closed ? "无" : "仍然挂着")")
        sheetWin.close()

        // 9) 按钮本身：点「确认裁剪 / 用全图」一定产出值（裁不出来传空串，
        //    confirmCrop 也会关窗提示，不会把用户留在弹窗里）
        let full = CropDialog.cropped(croppedURL, rect: CropRect(x: 0, y: 0, w: 1, h: 1))
        let part = CropDialog.cropped(croppedURL, rect: CropRect(x: 0.2, y: 0.2, w: 0.6, h: 0.6))
        check("确认裁剪有输出", part.hasPrefix("data:image/jpeg;base64,") && part.count > 200,
              "\(part.count) 字符")
        check("用全图输出比裁剪大", full.count > part.count,
              "全图 \(full.count) vs 裁剪 \(part.count)")
        check("坏图不返回半截 dataURL", CropDialog.cropped("坏图", rect: CropRect()) == "",
              "返回空串（交给 confirmCrop 关窗 + 提示）")

        log(failures == 0 ? "\n全部通过" : "\n\(failures) 项失败")
        log("日志：\(logURL.path)")
        exit(failures == 0 ? 0 : 1)
    }

    @MainActor
    private static func spin(_ seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    }
}

/// 裁剪弹窗宿主：只为探针复现真实 View 的观察条件（不放这里就得在 View 里暴露更多内部）
private struct SheetHost: View {
    @ObservedObject var state: TutorState
    var body: some View {
        Color.clear
            .frame(width: 420, height: 300)
            .sheet(isPresented: state.cropPresented) { Text("crop") }
    }
}
