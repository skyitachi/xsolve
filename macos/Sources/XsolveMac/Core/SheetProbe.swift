import AppKit
import SwiftUI

// MARK: - 回归探针：真实弹窗链 + 真实 ui_event → 弹窗真的挂上窗口
//
// 用法：`swift run XsolveMac --uisheet`（结果写 /tmp/xsolve-uisheet.log，跑完自动退出）
//
// 背景：用户报「AI 说出好了、在弹窗里确认一下，但没有弹窗」。原因有两层：
//   ① 事件解码口径错了（整包当题目解，`problem` 子字段没取）→ 状态永远是 nil；
//   ② 万一状态对了，五个 .sheet 挤在一条修饰符链上也得确认没互相挤掉。
// ① 由 `--uievent` 锁；② 这里验 —— 而且用的是 `TutorView` 真正挂的那份
// `TutorSheets` modifier，不是复制出来的结构，改挂载顺序也能测出来。

enum SheetProbe {
    static var active: Bool { CommandLine.arguments.contains("--uisheet") }

    private static let logURL = URL(fileURLWithPath: "/tmp/xsolve-uisheet.log")

    private static func log(_ s: String) {
        let line = s + "\n"
        if let h = try? FileHandle(forWritingTo: logURL) {
            h.seekToEndOfFile()
            h.write(Data(line.utf8))
            try? h.close()
        } else {
            try? line.write(to: logURL, atomically: true, encoding: .utf8)
        }
    }

    private static var failures = 0
    private static func check(_ name: String, _ ok: Bool, _ detail: String) {
        if ok { log("  ✓ \(name) — \(detail)") }
        else { failures += 1; log("  ✗ \(name) — \(detail)") }
    }

    /// 宿主：只放真实弹窗链（TutorView 里就是 `.tutorSheets(state)`）
    private struct Host: View {
        @ObservedObject var state: TutorState
        var body: some View {
            Color.clear
                .frame(width: 420, height: 300)
                .tutorSheets(state)
        }
    }

    /// 与后端 propose_problem 同形状（`problem` 包一层）
    private static let proposedEvent = """
    {"type":"problem_proposed","problem":{"id":"ai_1","topic":"几何",
    "text":"如图，在 $\\\\triangle ABC$ 中，求阴影面积。","answer":"12",
    "hints":["先算三角形面积"],"figure":{"type":"image"}}}
    """

    @MainActor
    static func runAndExit() {
        try? FileManager.default.removeItem(at: logURL)
        log("== 真实弹窗链 ==")

        let state = TutorState()
        let host = NSHostingView(rootView: AnyView(Host(state: state)))
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 300),
                         styleMask: [.titled], backing: .buffered, defer: false)
        w.contentView = host
        w.orderFront(nil)
        spin(0.8)

        // 1) 全链路：ui_event → proposal → sheet 真的挂到窗口上
        state.handleUiEvent(Data(proposedEvent.utf8))
        spin(1.6)
        let popped = w.attachedSheet != nil
        check("ui_event 能让出题确认弹窗真的弹出", popped,
              "attachedSheet = \(popped ? "有" : "无"), proposal = \(state.proposal?.id ?? "nil")")

        // 顺手把弹窗抓成图，人工看一眼内容（富文本 / 提示折叠 / 按钮）
        if let sheet = w.attachedSheet {
            let dir = "/tmp/xsolve-sheets"
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            let out = "\(dir)/proposal.png"
            try? FileManager.default.removeItem(atPath: out)
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            p.arguments = ["-x", "-o", "-l", String(sheet.windowNumber), out]
            try? p.run()
            p.waitUntilExit()
            let ok = FileManager.default.fileExists(atPath: out)
            log("  · 弹窗截图 \(ok ? "→ \(out)" : "失败（可能没有屏幕录制权限）")")
        }

        // 2) 关掉之后不能再挂着（proposal = nil 必须让 sheet 走掉）
        state.proposal = nil
        spin(1.0)
        let gone = w.attachedSheet == nil
        check("确认后弹窗正常收起", gone,
              "attachedSheet = \(gone ? "无" : "仍挂着")")

        // 3) 链上其余四个都要能单独弹（顺序被人挪过也知道）
        func probe(_ name: String, _ set: @escaping () -> Void, _ clear: @escaping () -> Void) {
            set()
            spin(1.2)
            let up = w.attachedSheet != nil
            clear()
            spin(0.6)
            let down = w.attachedSheet == nil
            check("\(name) 能弹出并收起", up && down,
                  up ? (down ? "正常" : "能弹但收不回") : "没弹出")
        }
        probe("手动输入题目", { state.showManualInput = true }, { state.showManualInput = false })
        probe("关于", { state.showAbout = true }, { state.showAbout = false })
        probe("删除确认",
              { state.deleteProposal = (ProposedProblem(id: "p1", topic: "行程", text: "题目",
                                                        answer: nil, hints: nil,
                                                        figure: nil, figureImage: nil), true) },
              { state.deleteProposal = nil })
        probe("裁剪",
              { state.cropSource = "data:image/jpeg;base64,AAAA" },
              { state.cropSource = nil })

        w.close()
        log(failures == 0 ? "\n全部通过" : "\n\(failures) 项失败")
        exit(failures == 0 ? 0 : 1)
    }

    private static func spin(_ seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }
}
