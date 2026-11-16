import SwiftUI
import AppKit

// MARK: - 「识别草稿」链路探针
//
// 用法：`.build/debug/XsolveMac --uirecog [--base http://localhost:8765]`
// 走的是按钮背后那条真实路径：TutorState.recognizeScratch() →
// syncScratchToServer()（POST /scratch + /scratch-image）→ runTurn() 真 SSE。
//
// 同时把 exportImage() 的结果落盘到 /tmp/xsolve-recog-export.jpg，
// 好确认「视觉模型收到的到底是不是一张像样的草稿图」——之前只验过「非空」，
// 结果模型读到的是糊成一片的图却被当成「识别功能坏了」。

@MainActor
enum RecogProbe {
    static var active: Bool { CommandLine.arguments.contains("--uirecog") }

    static let state = TutorState()
    nonisolated(unsafe) static var winProbe: NSWindow?

    private static let logURL = URL(fileURLWithPath: "/tmp/xsolve-uirecog.log")
    private static var started = Date()

    private static func log(_ s: String) {
        let line = String(format: "[%.1fs] %@\n", Date().timeIntervalSince(started), s)
        if let h = try? FileHandle(forWritingTo: logURL) {
            h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close()
        } else {
            try? line.write(to: logURL, atomically: true, encoding: .utf8)
        }
    }

    private static func base() -> String {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--base"), i + 1 < args.count { return args[i + 1] }
        return "http://localhost:8765"
    }

    private static func watchdog(_ seconds: Double) {
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
            let msg = "[watchdog] 主线程 \(Int(seconds))s 无进展 —— 判定卡死\n"
            if let h = try? FileHandle(forWritingTo: logURL) {
                h.seekToEndOfFile(); h.write(Data(msg.utf8)); try? h.close()
            }
            exit(2)
        }
    }

    static func autorun() {
        started = Date()
        watchdog(120)
        Task { @MainActor in
            // 真窗口：不给真布局的话 canvasSize 不会落地，导出会直接 return nil
            let host = NSHostingView(rootView: WorkPanel(state: state)
                .environmentObject(AppModel.shared)
                .frame(width: 760, height: 900))
            let win = NSWindow(contentRect: NSRect(x: 200, y: 120, width: 760, height: 900),
                               styleMask: [.titled, .closable], backing: .buffered, defer: false)
            win.title = "recognize probe"
            win.contentView = host
            win.orderFrontRegardless()
            winProbe = win
            log("window attached")

            APIClient.shared.baseURL = base()
            do {
                let u = try await APIClient.shared.login(username: "demo", password: "demo123")
                AppModel.shared.applyLogin(u)
                log("login ok")
            } catch {
                log("login FAILED \(error.localizedDescription)")
                exit(1)
            }
            await state.bootstrap(model: AppModel.shared)
            log("bootstrap session=\(state.sessionId ?? "nil")")
            guard state.sessionId != nil else { log("no session"); exit(1) }

            // 等布局落地：canvasSize 由 ScratchCanvasView 的 GeometryReader 写入
            try? await Task.sleep(nanoseconds: 900_000_000)
            log("canvasSize=\(String(describing: state.scratch.canvasSize))")

            // 画一条像样的演算过程（写「3+5=9」这种，视觉模型应能读出数字）
            let line: ([(Double, Double)]) -> Void = { pts in
                state.scratch.strokes.append(ScratchStroke(
                    t: "pen", p: pts.map { StrokePoint(x: $0.0, y: $0.1) }))
            }
            line([(60, 80), (150, 80)])
            line([(150, 80), (110, 130), (170, 130)])          // 近似 “3”
            line([(210, 130), (210, 80), (260, 80)])           // 近似 “5” 的轮廓
            line([(320, 80), (380, 80)])
            line([(380, 80), (320, 130), (380, 130)])          // 近似 “9”
            log("strokes=\(state.scratch.strokes.count)")

            guard let dataURL = state.scratch.exportImage() else {
                log("exportImage() → nil（canvasSize 没落地？）")
                exit(1)
            }
            let b64 = String(dataURL.dropFirst("data:image/jpeg;base64,".count))
            if let d = Data(base64Encoded: b64) {
                try? d.write(to: URL(fileURLWithPath: "/tmp/xsolve-recog-export.jpg"))
                log("exported jpeg bytes=\(d.count) → /tmp/xsolve-recog-export.jpg")
            } else {
                log("base64 解不开，长度 \(b64.count)")
            }

            let t0 = Date()
            await state.recognizeScratch()
            log("recognizeScratch returned in \(String(format: "%.1f", Date().timeIntervalSince(t0)))s, entries=\(state.entries.count)")

            for e in state.entries.suffix(6) {
                switch e.kind {
                case .user(let t, _): log("  [user] \(t.prefix(80))")
                case .ai(let b): log("  [ai] \(b.raw.prefix(240))")
                case .system(let t): log("  [sys] \(t.prefix(240))")
                case .error(let t): log("  [ERR] \(t.prefix(300))")
                case .tool(let c): log("  [tool] \(c.label) running=\(c.running) \(c.result?.prefix(120) ?? "")")
                case .diagram(_, let title): log("  [diagram] \(title)")
                }
            }
            log("turnInFlight=\(state.turnInFlight)")
            log("DONE")
            exit(0)
        }
    }
}
