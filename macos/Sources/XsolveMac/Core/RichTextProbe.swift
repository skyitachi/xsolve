import AppKit
import WebKit

// MARK: - 回归探针：富文本（WKWebView 路径）的高度上报
//
// 用法：`swift run XsolveMac --uirich`（结果写 /tmp/xsolve-uirich.log，跑完自动退出）
//
// 背景：题目里带 `$...$` 时走 WKWebView，SwiftUI 拿 `box.height` 固定 frame 高度。
// 高度一旦报小了，底部内容就被裁 —— 截图里「题目第二行只剩上半截」就是这个。
// 两个根因：
//   ① 只在 `__set` 之后 30ms 量一次，KaTeX 字体/图片晚到就漏掉；
//   ② 宽度变化（分栏拖动 / 窗口拉伸 / 做题区收起）后**完全不重测**，
//      窄了行数变多、高度还是旧的，底部直接被切。
//
// 断言（每个宽度都跑一遍）：
//   · 上报高度 ≥ 内容真实高度
//   · 把 frame 固定成上报高度后，内容底部仍在可视区内（= 最后一行不被裁）
//   · 首个段落的上边距被算进内容高度（#c 的 flow-root 防 margin collapse）
//   · 宽度收窄后高度必须变大（证明宽度变化真的触发了重测）

enum RichTextProbe {
    static var active: Bool { CommandLine.arguments.contains("--uirich") }

    private static let logURL = URL(fileURLWithPath: "/tmp/xsolve-uirich.log")

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

    /// 与截图同款：含 `$...$`，必定走 WebView 路径
    private static let sample = """
    甲、乙两人从相距 $400$ 千米的两地同时出发，相向而行。甲每小时行 $55$ 千米，乙每小时行 $45$ 千米，几小时后两人相遇？

    要求：先说明等量关系，再列式求解（用 $t$ 表示相遇时间）。
    """

    /// WKWebView 需要窗口才会真正排版（无窗口环境下 layout 是 0）
    private final class Sink: NSObject, WKScriptMessageHandler {
        var last: CGFloat = 0
        var count = 0
        func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
            guard m.name == "height", let n = m.body as? NSNumber else { return }
            last = CGFloat(truncating: n)
            count += 1
        }
    }

    private static func spin(_ seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    }

    static func runAndExit() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        log("==> 富文本高度上报探针（MarkdownWebView）")

        let base = URL(string: APIClient.shared.baseURL) ?? URL(string: "http://localhost:8765")!
        let sink = Sink()
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(sink, name: "height")

        let startW: CGFloat = 580, startH: CGFloat = 460
        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: startW, height: startH), configuration: cfg)
        wv.setValue(false, forKey: "drawsBackground")
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: startW, height: startH),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        win.contentView = wv
        win.orderBack(nil)

        wv.loadHTMLString(MarkdownWebView.html(base: base.absoluteString, fontSize: 14, isUserInput: false),
                          baseURL: base)
        let deadline = Date().addingTimeInterval(20)
        while wv.isLoading && Date() < deadline { spin(0.05) }
        spin(1.0)

        func eval(_ js: String) -> String {
            var result = "<无返回>"
            var done = false
            wv.evaluateJavaScript(js) { v, e in
                if let e { result = "error: \(e.localizedDescription)" }
                else if let v { result = "\(v)" }
                done = true
            }
            let until = Date().addingTimeInterval(8)
            while !done && Date() < until { spin(0.02) }
            return result
        }

        // 塞入题目正文（与 TutorState 发给 MarkdownWebView 的 payload 一致：[text, isUserInput]）
        let json = (try? JSONEncoder().encode(sample)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
        _ = eval("__set([\(json), false])")
        spin(1.6)

        let hasKatex = eval("document.querySelector('.katex') ? 'true' : 'false'")
        check("题目进了公式渲染路径", hasKatex == "true", ".katex = \(hasKatex)（false 说明 katex 资源没加载）")

        var heightAt: [CGFloat: CGFloat] = [:]

        // 依次把窗口改到几种真实宽度：展开左栏 / 收起左栏 / 拖到很窄
        for w in [580.0, 420.0, 300.0] {
            win.setContentSize(NSSize(width: w, height: 460))
            // 宽度变化 → 页面里的 ResizeObserver / resize 事件应当重测并上报
            spin(1.2)

            let reported = sink.last
            heightAt[CGFloat(w)] = reported

            // 模拟 SwiftUI 的 .frame(height: box.height)
            win.setContentSize(NSSize(width: w, height: max(reported, 40)))
            spin(0.45)

            let docH = Double(eval("document.getElementById('c').getBoundingClientRect().height")) ?? -1
            let clientH = Double(eval("document.documentElement.clientHeight")) ?? -1
            let bottom = Double(eval("document.getElementById('c').getBoundingClientRect().bottom")) ?? -1
            let pTop = Double(eval("(function(){var p=document.querySelector('#c p');return p?p.getBoundingClientRect().top-document.getElementById('c').getBoundingClientRect().top:-1})()")) ?? -1

            log(String(format: "  · 宽度 %.0f：上报 %.1f，内容 %.1f，可视 %.1f，底部 %.1f",
                       w, Double(reported), docH, clientH, bottom))

            check("宽 \(Int(w))：上报高度不小于内容高度",
                  Double(reported) + 0.5 >= docH,
                  String(format: "上报 %.1f vs 内容 %.1f（差 %.1f）",
                         Double(reported), docH, Double(reported) - docH))

            check("宽 \(Int(w))：最后一行没被裁",
                  bottom > 0 && bottom <= clientH + 1,
                  String(format: "内容底部 %.1f / 可视高 %.1f", bottom, clientH))

            check("宽 \(Int(w))：首段上边距算进高度",
                  pTop > 4,
                  String(format: "p.top - c.top = %.1f（≤0 说明 margin 塌陷、顶部会被切）", pTop))
        }

        // 宽度收窄 → 行数变多 → 高度必须跟着涨。
        // 只拿 580→300 这一档判：580 与 420 可能仍落在同样的行数上（这段文字就是），
        // 那不是 bug，硬断言会假失败。
        let h580 = heightAt[580] ?? 0, h420 = heightAt[420] ?? 0, h300 = heightAt[300] ?? 0
        check("窄到 300 后高度变大（证明宽度变化触发了重测）",
              h300 > h580,
              String(format: "580→%.1f  420→%.1f  300→%.1f", Double(h580), Double(h420), Double(h300)))

        log(failures == 0 ? "\n全部通过" : "\n\(failures) 项失败")
        log("日志：\(logURL.path)")
        exit(failures == 0 ? 0 : 1)
    }
}
