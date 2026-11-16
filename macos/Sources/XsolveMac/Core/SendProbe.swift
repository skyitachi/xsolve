import SwiftUI
import AppKit

// MARK: - 真实发送链路探针
//
// 用法：`swift run XsolveMac --uisend [--base http://localhost:8765]`
// 做的是「点发送」那一刻的完整链路：登录 → 建会话 → 真 ChatPanel 渲染 →
// runTurn 走完真实 SSE（含工具卡片、草稿同步），结果写 /tmp/xsolve-uisend.log。
//
// 关键断言：终态 `live` 不应该随对话轮次/消息条数增长（说明 webview 没有泄漏），
// 且整个过程不能触发 30s 看门狗（说明主线程没有被 WKWebView 初始化卡住）。

@MainActor
enum SendProbe {
    static var active: Bool { CommandLine.arguments.contains("--uisend") }

    static let state = TutorState()
    nonisolated(unsafe) static var winProbe: NSWindow?

    nonisolated static let logURL = URL(fileURLWithPath: "/tmp/xsolve-uisend.log")
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

    /// 主线程卡死时只有后台线程还能跑 —— 用后台看门狗兜底，卡住也能给出结论
    private static func watchdog(_ seconds: Double) {
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
            let msg = "[watchdog] 主线程 \(Int(seconds))s 无进展 —— 判定卡死（created=\(RichText.createdCount) live=\(RichText.liveCount)）\n"
            if let h = try? FileHandle(forWritingTo: logURL) {
                h.seekToEndOfFile(); h.write(Data(msg.utf8)); try? h.close()
            }
            exit(2)
        }
    }

    static func autorun() {
        started = Date()
        watchdog(30)
        Task { @MainActor in
            // 无窗口环境下 WindowGroup 不会真的开窗（windows=0），必须自己挂一个
            // NSHostingView 才能触发真实布局 —— 否则 created 恒 0，等于什么都没验证。
            let host = NSHostingView(rootView: ChatPanel(state: state)
                .environmentObject(AppModel.shared)
                .frame(width: 560, height: 780))
            let win = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 560, height: 780),
                               styleMask: [.titled, .closable], backing: .buffered, defer: false)
            win.title = "send probe"
            win.contentView = host
            win.orderFrontRegardless()
            winProbe = win
            log("window attached orderFront")

            APIClient.shared.baseURL = base()
            log("base=\(APIClient.shared.baseURL)")
            do {
                let u = try await APIClient.shared.login(username: "demo", password: "demo123")
                AppModel.shared.applyLogin(u)
                log("login ok user=\(u.username) created=\(RichText.createdCount)")
            } catch {
                log("login FAILED: \(error.localizedDescription)")
                exit(1)
            }

            await state.bootstrap(model: AppModel.shared)
            log("bootstrap session=\(state.sessionId ?? "nil") problems=\(state.problems.count) live=\(RichText.liveCount)")

            guard state.sessionId != nil else {
                log("no session — abort")
                exit(1)
            }

            state.userMsg("1+1=?")
            // 给 SwiftUI 一个渲染窗口，确认视图真的被布局了（否则 created 恒 0 不可信）
            try? await Task.sleep(nanoseconds: 800_000_000)
            let visible = NSApp.windows.filter(\.isVisible).count
            log("windows=\(NSApp.windows.count) visible=\(visible) entries=\(state.entries.count) created=\(RichText.createdCount)")
            log("send start created=\(RichText.createdCount) live=\(RichText.liveCount)")
            await state.runTurn("1+1=?")
            log("turn done entries=\(state.entries.count) created=\(RichText.createdCount) live=\(RichText.liveCount)")

            // 再来一轮公式题：强制走 WKWebView 渲染路径，确认这条路上也不泄漏
            let mathAsk = "请用 LaTeX 公式写出圆锥体积公式，并逐项解释。"
            state.userMsg(mathAsk)
            await state.runTurn(mathAsk)
            log("turn2 done entries=\(state.entries.count) created=\(RichText.createdCount) live=\(RichText.liveCount)")

            // 第三轮：确认轮次增加不会让存活 webview 数继续涨
            state.userMsg("谢谢")
            await state.runTurn("谢谢")
            log("turn3 done entries=\(state.entries.count) created=\(RichText.createdCount) live=\(RichText.liveCount)")

            log("DONE")
            exit(0)
        }
    }
}
