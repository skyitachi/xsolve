import SwiftUI
import AppKit

// MARK: - 回归探针：消息列表反复重算时，WKWebView 会不会被反复重建
//
// 用法：`swift run XsolveMac --uiprobe`（结果写 /tmp/xsolve-uiprobe.log，跑完自动退出）
//
// 背景：ChatEntry.id 曾写成计算属性、每次返回新 UUID，`ForEach` 每重算一次就把所有行
// 当新视图重建一次，每次重建 new 一个 WKWebView（各自拉起一个 WebContent 进程）。
// 打字/流式时进程数会涨到几百个，最终新建 WKWebView 卡死在 IORegisterForSystemPower。
// 断言：模拟 20 次输入 + 10 次流式增量后，created 不应随重算次数线性增长。

final class ProbeModel: ObservableObject {
    @Published var entries: [ChatEntry] = []
    @Published var input = ""
}

struct ProbeRoot: View {
    @ObservedObject var m: ProbeModel

    var body: some View {
        VStack(spacing: 0) {
            // 模拟输入框：每敲一个字都会让本 body 重算（与 ChatPanel 一致）
            TextField("input", text: $m.input)
                .padding(8)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(m.entries) { entry in
                        ChatEntryView(entry: entry)
                            .id(entry.id)
                    }
                }
                .padding(12)
            }
        }
        .frame(width: 520, height: 640)
    }
}

enum UIProbe {
    static var active: Bool { CommandLine.arguments.contains("--uiprobe") }

    /// 探针界面与驱动共用同一实例
    static let model = makeModel()

    private static let logURL = URL(fileURLWithPath: "/tmp/xsolve-uiprobe.log")

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

    static func makeModel() -> ProbeModel {
        let m = ProbeModel()
        let b1 = AiTextBlock(raw: "先看看这道题：**求圆锥体积**，底面半径 $r=3$，高 $h=4$。", streaming: false)
        let b2 = AiTextBlock(raw: "提示：体积公式是 $V=\\frac{1}{3}\\pi r^2 h$，代入即可。", streaming: false)
        m.entries = [
            .user(text: "这题怎么做？", imageData: nil),
            .ai(b1),
            .system("已切换到学生版"),
            .user(text: "我算出 12π", imageData: nil),
            .ai(b2),
            .user(text: "对吗", imageData: nil),
            .user(text: "再讲讲", imageData: nil),
            .user(text: "谢谢", imageData: nil),
        ]
        return m
    }

    /// 由 App.init 调度（不依赖 onAppear：无窗口环境下 onAppear 不触发）
    static func autorun() {
        // 先让首帧布局跑完，再开始计数
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            RichText.createdCount = 0
            log("[probe] start rows=\(model.entries.count)")
            step(1)
        }
    }

    private static func step(_ i: Int) {
        if i <= 20 {
            // 模拟连续输入：每敲一个字重算一次 body
            model.input = String(repeating: "字", count: i)
            if i % 5 == 0 { log("[probe] keystroke \(i) created=\(RichText.createdCount) live=\(RichText.liveCount)") }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { step(i + 1) }
            return
        }
        log("[probe] typing done created=\(RichText.createdCount) live=\(RichText.liveCount)")
        // 模拟流式：增量修改最后一条 AI 文本 10 次（entries 本身不变）
        var n = 0
        func stream() {
            if n < 10 {
                n += 1
                if case .ai(let b) = model.entries[model.entries.count - 2].kind { b.raw += "…" }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { stream() }
            } else {
                log("[probe] DONE rows=\(model.entries.count) created=\(RichText.createdCount) live=\(RichText.liveCount)")
                exit(0)
            }
        }
        stream()
    }
}
