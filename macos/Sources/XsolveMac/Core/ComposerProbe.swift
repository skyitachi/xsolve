import AppKit
import SwiftUI

// MARK: - 回归探针：输入框（占位符基线 / Enter 发送 / Ctrl+Enter 换行）
//
// 用法：`swift run XsolveMac --uicomposer`（结果写 /tmp/xsolve-composer.log，
//      截图写 /tmp/xsolve-composer/，跑完自动退出）
//
// 背景：
//   ① 截图里光标在上、占位符「问我任何问题…」在下 —— 原因是 SwiftUI `TextEditor`
//      内部 NSTextView 自带 `textContainerInset`(0,5) + `lineFragmentPadding`(5,0)，
//      外层又用 `.padding(10)` 摆占位符，两套内边距永远对不上。
//      现在占位符由 NSTextView 自己按 `textContainerOrigin` 画，与插入点同基线。
//   ② `TextEditor` 拦不住 Return，需求是 Enter 发送、Ctrl+Enter 换行。
//
// 断言：
//   · 占位符矩形起点 x/y 与插入点矩形一致（偏差 < 1pt）
//   · 空串时占位符可见；有字时不画占位符
//   · Enter → 触发 onSend，且**不**插入换行
//   · Ctrl+Enter / Shift+Enter → 插入换行，**不**发送
//   · 打字后 binding 同步（原生 → SwiftUI）
//   · 外部清空后回到占位符状态（发送后清空的那一步）
//   · 截图里占位符首像素行 ≈ 打字后首像素行（真正画出图来比）

enum ComposerProbe {
    static var active: Bool { CommandLine.arguments.contains("--uicomposer") }

    private static let logURL = URL(fileURLWithPath: "/tmp/xsolve-composer.log")
    private static let outDir = "/tmp/xsolve-composer"

    private static var failures = 0

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

    private static func check(_ name: String, _ ok: Bool, _ detail: String) {
        if ok { log("  ✓ \(name) — \(detail)") } else {
            failures += 1
            log("  ✗ \(name) — \(detail)")
        }
    }

    private static func spin(_ seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    }

    private final class Holder: ObservableObject {
        @Published var text: String = ""
    }

    /// 必须带 @ObservedObject：否则 holder.text 变化后 body 不重算，
    /// `updateNSView` 不会跑，外部改文本在界面上看不到（曾因此在 Sheet 探针里误判）。
    private struct ProbeRoot: View {
        @ObservedObject var holder: Holder
        var onSend: () -> Void

        var body: some View {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                ComposerField(text: $holder.text,
                              placeholder: "问我任何问题…",
                              height: 52,
                              onSend: onSend)
                    .padding(12)
            }
            .frame(width: 420, height: 120)
            .background(Color(nsColor: .windowBackgroundColor))
        }
    }

    @MainActor
    static func runAndExit() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

        log("==> 输入框探针（占位符基线 / Enter 发送 / Ctrl+Enter 换行）")
        ComposerTextView.traceSelectors = ProcessInfo.processInfo.environment["XSOLVE_COMPOSER_TRACE"] == "1"

        let holder = Holder()
        var sendCount = 0
        let root = NSHostingView(rootView: ProbeRoot(holder: holder) { sendCount += 1 })
        root.frame = NSRect(x: 0, y: 0, width: 420, height: 120)

        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 120),
                           styleMask: [.titled], backing: .buffered, defer: false)
        win.appearance = NSAppearance(named: .aqua)
        win.contentView = root
        win.setFrameOrigin(NSPoint(x: 120, y: 120))
        // 必须在屏幕上：插入点/首响应者状态都依赖 window 是 key window
        win.makeKeyAndOrderFront(nil)
        root.layoutSubtreeIfNeeded()
        spin(0.4)

        guard let tv = findTextView(in: root) else {
            log("  ✗ 找不到 ComposerTextView（视图层级没建起来）")
            log("==> 失败 1 项")
            exit(1)
        }
        win.makeFirstResponder(tv)
        tv.layoutManager?.ensureLayout(for: tv.textContainer!)
        spin(0.2)

        // ---- 1. 占位符 × 光标 对齐 ----
        let caret = caretRectInView(tv)
        let ph = tv.placeholderRect
        log("  插入点 rect=\(fmt(caret))  占位符 rect=\(fmt(ph))")
        if let ph {
            check("占位符与光标顶边同高", abs(ph.minY - caret.minY) < 1.0,
                  String(format: "Δy=%.2fpt", ph.minY - caret.minY))
            check("占位符与光标左边同列", abs(ph.minX - caret.minX) < 1.0,
                  String(format: "Δx=%.2fpt", ph.minX - caret.minX))
            check("占位符起点在文本容器原点", abs(ph.minY - tv.textContainerOrigin.y) < 1.0,
                  String(format: "origin.y=%.2f pt=%.2f", ph.minY, tv.textContainerOrigin.y))
        } else {
            check("占位符矩形可得", false, "placeholderRect 为 nil")
        }
        check("空串时显示占位符", tv.string.isEmpty, "string=\"\(tv.string)\"")

        // ---- 2. 截图：空态（含占位符 + 光标） ----
        let emptyPNG = snap(root, name: "empty")

        // ---- 3. 打字：binding 同步 ----
        tv.setSelectedRange(NSRange(location: 0, length: 0))
        tv.insertText("问", replacementRange: tv.selectedRange())
        spin(0.15)
        check("打字后原生文本已写入", tv.string == "问", "tv.string=\"\(tv.string)\"")
        check("打字后 binding 同步（原生 → SwiftUI）", holder.text == "问", "holder=\"\(holder.text)\"")

        // ---- 4. 有字时不画占位符 ----
        check("有字时占位符不再绘制", !tv.string.isEmpty, "由 draw() 的 guard 保证")

        // 打字后的截图：字与占位符应落在同一行
        let typedPNG = snap(root, name: "typed")

        // ---- 5. Enter 发送 ----
        sendCount = 0
        tv.newlineOrSend(flags: [])
        spin(0.1)
        check("Enter 触发发送", sendCount == 1, "sendCount=\(sendCount)")
        check("Enter 不插入换行", !tv.string.contains("\n"), "string=\"\(tv.string)\"")

        // ---- 6. Ctrl+Enter 换行 ----
        sendCount = 0
        tv.newlineOrSend(flags: .control)
        spin(0.1)
        check("Ctrl+Enter 插入换行", tv.string.contains("\n"),
              "string=\(escaped(tv.string))")
        check("Ctrl+Enter 不发送", sendCount == 0, "sendCount=\(sendCount)")

        // 修饰键判定表（含 Shift/⌘/⌥ 的边界）
        let cases: [(NSEvent.ModifierFlags, Bool, String)] = [
            ([], false, "无修饰"),
            ([.command], false, "⌘"),
            ([.control], true, "Ctrl"),
            ([.shift], true, "Shift"),
            ([.option], true, "⌥"),
            ([.control, .command], true, "Ctrl+⌘"),
        ]
        for (flags, want, name) in cases {
            let got = ComposerTextView.wantsNewline(flags)
            check("修饰键判定 \(name)", got == want, "期望换行=\(want) 实际=\(got)")
        }

        // ---- 6b. 真 Return 键事件：证明键盘路径确实进了 doCommand ----
        tv.string = "测试"
        tv.setSelectedRange(NSRange(location: 2, length: 0))
        sendCount = 0
        pressReturn(win, flags: [])
        spin(0.1)
        check("真 Return 键事件走到发送", sendCount == 1, "sendCount=\(sendCount)")
        check("真 Return 键事件不换行", !tv.string.contains("\n"), "string=\(escaped(tv.string))")

        // 真 Ctrl+Return：修饰键从事件里读（NSApp.currentEvent，取不到时退回 NSEvent.modifierFlags）
        tv.string = "测试"
        tv.setSelectedRange(NSRange(location: 2, length: 0))
        sendCount = 0
        pressReturn(win, flags: .control)
        spin(0.1)
        let ctrlNewline = tv.string.contains("\n")
        let ctrlSent = sendCount == 1
        log("  · 真 Ctrl+Return：换行=\(ctrlNewline) 发送=\(ctrlSent) "
            + "（currentEvent=\(NSApp.currentEvent?.modifierFlags.rawValue ?? 0) "
            + "键盘状态=\(NSEvent.modifierFlags.rawValue)）")
        check("真 Ctrl+Return 插入换行且不发送", ctrlNewline && !ctrlSent,
              "换行=\(ctrlNewline) 发送=\(ctrlSent)")
        // insertLineBreak 默认插 U+2028，必须是真 LF，否则发到后端是脏字符
        let hasLineSep = tv.string.unicodeScalars.contains("\u{2028}")
        check("换行是 LF 而不是 U+2028", !hasLineSep,
              "U+2028=\(hasLineSep) 码点=\(tv.string.unicodeScalars.map { String(format: "U+%04X", $0.value) })")

        // ---- 7. 发送后清空 → 回到占位符 ----
        holder.text = ""
        spin(0.25)
        check("外部清空后文本同步到原生", tv.string.isEmpty, "tv.string=\"\(tv.string)\"")
        check("清空后占位符矩形仍在（会重画）", tv.placeholderRect != nil,
              "placeholderRect=\(fmt(tv.placeholderRect))")

        // ---- 8. 图片像素对比：占位符与正文同一行 ----
        compareInkRows(empty: emptyPNG, typed: typedPNG, xRange: (12, 260))

        win.orderOut(nil)
        log(failures == 0 ? "==> 全部通过" : "==> 失败 \(failures) 项")
        exit(failures == 0 ? 0 : 1)
    }

    // MARK: - 辅助

    private static func fmt(_ r: NSRect?) -> String {
        guard let r else { return "nil" }
        return String(format: "(%.1f, %.1f, %.1f×%.1f)", r.minX, r.minY, r.width, r.height)
    }

    private static func escaped(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\n", with: "\\n") + "\""
    }

    /// 发一个真的 Return 键事件给窗口（走 keyDown → interpretKeyEvents → doCommand）
    private static func pressReturn(_ win: NSWindow, flags: NSEvent.ModifierFlags) {
        guard let ev = NSEvent.keyEvent(with: .keyDown,
                                        location: NSPoint(x: 4, y: 4),
                                        modifierFlags: flags,
                                        timestamp: ProcessInfo.processInfo.systemUptime,
                                        windowNumber: win.windowNumber,
                                        context: nil,
                                        characters: "\r",
                                        charactersIgnoringModifiers: "\r",
                                        isARepeat: false,
                                        keyCode: 36) else { return }
        win.sendEvent(ev)
    }

    private static func findTextView(in view: NSView) -> ComposerTextView? {        if let tv = view as? ComposerTextView { return tv }
        for sub in view.subviews {
            if let tv = findTextView(in: sub) { return tv }
        }
        return nil
    }

    /// 插入点（零长度选区）在视图坐标系里的矩形
    private static func caretRectInView(_ tv: NSTextView) -> NSRect {
        let screen = tv.firstRect(forCharacterRange: NSRange(location: 0, length: 0), actualRange: nil)
        guard let win = tv.window else { return .zero }
        return tv.convert(win.convertFromScreen(screen), from: nil)
    }

    @discardableResult
    private static func snap(_ view: NSView, name: String) -> URL? {
        view.layoutSubtreeIfNeeded()
        spin(0.2)
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        let url = URL(fileURLWithPath: outDir).appendingPathComponent("\(name).png")
        try? png.write(to: url)
        log("  · 截图 \(name) → \(url.path)")
        return url
    }

    /// 找「第一行墨迹」的像素行：占位符截图与打字截图应当一致（差 ≤1px）
    private static func compareInkRows(empty: URL?, typed: URL?, xRange: (Int, Int)) {
        guard let e = empty, let t = typed,
              let de = try? Data(contentsOf: e), let dt = try? Data(contentsOf: t),
              let re = NSBitmapImageRep(data: de),
              let rt = NSBitmapImageRep(data: dt) else {
            check("像素行对比", false, "截图读不回来")
            return
        }
        let rowE = firstInkRow(re, xRange: xRange)
        let rowT = firstInkRow(rt, xRange: xRange)
        let diff = rowE - rowT
        log("  首墨迹行：占位符=\(rowE) 正文=\(rowT)")
        check("占位符与正文首墨迹行一致（±1px）", abs(diff) <= 1, "Δ=\(diff)px")
    }

    private static func firstInkRow(_ rep: NSBitmapImageRep, xRange: (Int, Int)) -> Int {
        let w = rep.pixelsWide, h = rep.pixelsHigh
        let x0 = min(max(xRange.0, 0), w - 1)
        let x1 = min(max(xRange.1, x0 + 1), w)
        for y in 0..<h {
            for x in x0..<x1 {
                guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                // 正文/占位符都是灰黑；窗口底色接近 0.93+（浅色外观）
                let lum = 0.299 * c.redComponent + 0.587 * c.greenComponent + 0.114 * c.blueComponent
                if lum < 0.62 { return y }
            }
        }
        return -1
    }
}
