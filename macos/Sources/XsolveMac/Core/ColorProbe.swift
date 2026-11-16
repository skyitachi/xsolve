import AppKit
import WebKit

// MARK: - 回归探针：富文本在深色/浅色外观下的实际取色
//
// 用法：`swift run XsolveMac --uicolors`（结果写 /tmp/xsolve-uicolors.log，跑完自动退出）
//
// 背景：题目/消息走 RichText，纯文本走原生 Text、含公式或 Markdown 走 WKWebView。
// 两条路径都曾把文字颜色写死成 #1F2937，深色外观下就是黑字压黑底 —— 肉眼只能看出
// 「有字但看不清」，用截图很难判定到底是哪条路径。这里直接问渲染引擎要 computed color。
//
// 断言：
//   深色 → body 颜色接近 #E3E4E8，且 matchMedia 命中 dark
//   浅色 → body 颜色回到 #1F2937
//   原生 Text 用的 .primary 等价 NSColor.labelColor，深色下必须是浅色

enum ColorProbe {
    static var active: Bool { CommandLine.arguments.contains("--uicolors") }

    private static let logURL = URL(fileURLWithPath: "/tmp/xsolve-uicolors.log")

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
        if ok {
            log("  ✓ \(name) — \(detail)")
        } else {
            failures += 1
            log("  ✗ \(name) — \(detail)")
        }
    }

    /// 在指定外观下解析动态系统色
    private static func resolvedLabel(_ appearance: NSAppearance) -> NSColor {
        var out = NSColor.black
        appearance.performAsCurrentDrawingAppearance {
            out = NSColor.labelColor.usingColorSpace(.sRGB) ?? .black
        }
        return out
    }

    private static func hex(_ c: NSColor) -> String {
        String(format: "#%02X%02X%02X",
               Int((c.redComponent * 255).rounded()),
               Int((c.greenComponent * 255).rounded()),
               Int((c.blueComponent * 255).rounded()))
    }

    static func runAndExit() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        let dark = NSAppearance(named: .darkAqua)!
        let light = NSAppearance(named: .aqua)!

        log("==> 富文本取色探针（RichText / MarkdownWebView）")

        // 1) 原生路径：.primary ↔ NSColor.labelColor
        let darkLabel = resolvedLabel(dark)
        let lightLabel = resolvedLabel(light)
        let dLum = 0.299 * darkLabel.redComponent + 0.587 * darkLabel.greenComponent + 0.114 * darkLabel.blueComponent
        check("原生 Text 深色下为浅色字", dLum > 0.6, "labelColor(dark) = \(hex(darkLabel))")
        let lLum = 0.299 * lightLabel.redComponent + 0.587 * lightLabel.greenComponent + 0.114 * lightLabel.blueComponent
        check("原生 Text 浅色下为深色字", lLum < 0.4, "labelColor(light) = \(hex(lightLabel))")

        // 2) WebView 路径：真开一个 WKWebView，深色外观下加载同一份 HTML
        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 420))
        wv.setValue(false, forKey: "drawsBackground")
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 420),
                           styleMask: [.borderless], backing: .buffered, defer: false)
        win.appearance = dark
        win.contentView = wv
        win.orderBack(nil)   // 无窗口环境下也必须有 window，否则 effectiveAppearance 不生效

        let base = URL(string: APIClient.shared.baseURL) ?? URL(string: "http://localhost:8765")!
        wv.loadHTMLString(MarkdownWebView.html(base: base.absoluteString, fontSize: 14, isUserInput: false),
                          baseURL: base)

        // 等页面就绪（脚本里有 marked/katex，didFinish 时 DOM 已可用）
        let deadline = Date().addingTimeInterval(20)
        while wv.isLoading && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))

        func eval(_ js: String) -> String {
            var result = "<无返回>"
            var done = false
            wv.evaluateJavaScript(js) { v, e in
                if let e { result = "error: \(e.localizedDescription)" }
                else if let v { result = "\(v)" }
                done = true
            }
            let until = Date().addingTimeInterval(8)
            while !done && Date() < until {
                RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            }
            return result
        }

        let darkMatch = eval("matchMedia('(prefers-color-scheme: dark)').matches ? 'true' : 'false'")
        check("WKWebView 继承深色外观", darkMatch == "true", "prefers-color-scheme dark = \(darkMatch)")

        // 塞两段真实内容：左图右公式，验证 body/代码块/公式都跟着变
        _ = eval("__set(['**求体积**，底面半径 $r=3$，高 $h=4$。\\n\\n|项|值|\\n|---|---|\\n|r|3|', false])")
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))

        let bodyDark = eval("getComputedStyle(document.body).color")
        check("深色下正文不发黑", isLightColor(bodyDark), "body color = \(bodyDark)")

        let tdDark = eval("(function(){var t=document.querySelector('td');return t?getComputedStyle(t).color:'<无表格>'})()")
        check("深色下表格文字可读", isLightColor(tdDark), "td color = \(tdDark)")

        let katexColor = eval("(function(){var k=document.querySelector('.katex');return k?getComputedStyle(k).color:'<无公式>'})()")
        check("深色下公式可读", isLightColor(katexColor), "katex color = \(katexColor)")

        // 3) 运行中切换到浅色外观：媒体查询要能实时跟上（用户在系统设置里切主题）
        win.appearance = light
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        let lightMatch = eval("matchMedia('(prefers-color-scheme: dark)').matches ? 'true' : 'false'")
        let bodyLight = eval("getComputedStyle(document.body).color")
        check("切换浅色后实时生效", lightMatch == "false" && isDarkColor(bodyLight),
              "prefers-dark = \(lightMatch), body color = \(bodyLight)")

        log(failures == 0 ? "\n全部通过" : "\n\(failures) 项失败")
        log("日志：\(logURL.path)")
        exit(failures == 0 ? 0 : 1)
    }

    /// 解析 "rgb(r, g, b)" / "rgba(...)"，返回感知亮度
    private static func luminance(_ css: String) -> Double? {
        guard let open = css.firstIndex(of: "("), let close = css.firstIndex(of: ")") else { return nil }
        let parts = css[css.index(after: open)..<close]
            .split(separator: ",")
            .compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count >= 3 else { return nil }
        return (0.299 * parts[0] + 0.587 * parts[1] + 0.114 * parts[2]) / 255.0
    }

    private static func isLightColor(_ css: String) -> Bool {
        guard let l = luminance(css) else { return false }
        return l > 0.55
    }

    private static func isDarkColor(_ css: String) -> Bool {
        guard let l = luminance(css) else { return false }
        return l < 0.45
    }
}
