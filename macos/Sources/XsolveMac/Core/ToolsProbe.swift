import AppKit
import SwiftUI

// MARK: - 视觉探针：左栏被压窄时，做题区按钮是否还完整可见
//
// 用法：`swift run XsolveMac --uitools [--out /tmp/xsolve-tools]`（跑完自动退出）
//
// 背景：工具条曾用 ScrollView(.horizontal) + showsIndicators:false，左栏一收窄，
// 右侧的「识别草稿 / 拍解答 / 输入题目」就被推到可视区外，看起来像被对话栏遮住。
// 「显示做题区」按钮也曾和题号、主题挤在一个 HStack 里，窄栏下被顶出边界。
// 这里把做题区/题目区按几种真实宽度离屏渲染成 PNG，并对右边界做像素检查，
// 避免这类「静默裁掉」再回归。

enum ToolsProbe {
    static var active: Bool { CommandLine.arguments.contains("--uitools") }

    private static var outDir: String {
        if let i = CommandLine.arguments.firstIndex(of: "--out"),
           i + 1 < CommandLine.arguments.count {
            return CommandLine.arguments[i + 1]
        }
        return "/tmp/xsolve-tools"
    }

    @MainActor
    private static let state = TutorState()

    private static var failures = 0

    @MainActor
    static func runAndExit() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

        print("==> 左栏窄宽度渲染（输出目录 \(outDir)）")

        for w in [320.0, 420.0, 560.0, 760.0] {
            snap("work-\(Int(w))", WorkPanel(state: state), width: w, height: 300)
        }
        // 收起做题区：题目区标题行是唯一的恢复入口，300pt 也不能被裁
        for w in [300.0, 380.0, 520.0] {
            snap("problem-hidden-\(Int(w))",
                 ProblemPanel(state: state, workPanelHidden: .constant(true)),
                 width: w, height: 220)
        }
        snap("problem-shown-420",
             ProblemPanel(state: state, workPanelHidden: .constant(false)),
             width: 420, height: 220)

        print(failures == 0 ? "\n全部通过" : "\n\(failures) 项失败")
        exit(failures == 0 ? 0 : 1)
    }

    @MainActor
    private static func snap(_ name: String, _ view: some View, width: Double, height: Double) {
        let host = NSHostingView(rootView: AnyView(
            view
                .frame(width: width, height: height)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, .light)
        ))
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        host.appearance = NSAppearance(named: .aqua)
        host.layoutSubtreeIfNeeded()
        spin(0.3)
        host.layoutSubtreeIfNeeded()

        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            print("  ✗ \(name)：拿不到位图"); failures += 1; return
        }
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            print("  ✗ \(name)：PNG 编码失败"); failures += 1; return
        }
        let url = URL(fileURLWithPath: outDir).appendingPathComponent("\(name).png")
        try? png.write(to: url)

        let clipped = hasContentNearRightEdge(rep)
        if clipped { failures += 1 }
        print("  \(clipped ? "✗ 右边界仍有内容（被裁）" : "✓ 右边界留白")  \(name) → \(url.path)")
    }

    /// 采样上半部分每行最右侧 6 个像素：出现明显不是窗口底色的像素，说明内容压到了边界
    private static func hasContentNearRightEdge(_ rep: NSBitmapImageRep) -> Bool {
        let w = rep.pixelsWide, h = rep.pixelsHigh
        guard w > 12, h > 12 else { return false }
        var hits = 0
        for y in stride(from: 0, to: min(h, 260), by: 2) {
            for x in stride(from: w - 6, to: w, by: 1) {
                guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                // 窗口底色（浅色）≈ 0.93~1.0；按钮描边/文字/胶囊明显更暗或带色
                if c.redComponent < 0.86 || c.greenComponent < 0.86 || c.blueComponent < 0.86 {
                    hits += 1
                }
            }
        }
        return hits > 3
    }

    @MainActor
    private static func spin(_ seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    }
}
