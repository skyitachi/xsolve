import SwiftUI
import AppKit

// MARK: - 多行输入框（Enter 发送 / Ctrl+Enter 换行 / 占位符与光标严格同基线）

/// 为什么要自己包一层 NSTextView：
/// 1. SwiftUI 的 `TextEditor` 在 NSTextView 内部自带 `textContainerInset`（垂直 5pt）和
///    `lineFragmentPadding`（水平 5pt），外面再叠 `.padding()` 做占位符，两者**必然错位**
///    （截图里就是：光标在上、占位符在下）。这里让占位符直接由 NSTextView 用同一套
///    `textContainerOrigin + 字体` 画出来，基线由文本系统自己算，永远不会偏。
/// 2. `TextEditor` 无法拦截 Return —— 要「Enter 发送 / Ctrl+Enter 换行」只能接管
///    `doCommand(by:)`。
/// 3. 顺手关掉智能引号/破折号替换：数学内容里的 `"`、`-` 不能被改写。
final class ComposerTextView: NSTextView {
    var placeholder: String = "" {
        didSet { needsDisplay = true }
    }

    /// Return 键回调；为 nil 时 Return 退化成换行
    var onSend: (() -> Void)?
    var onFocusChange: ((Bool) -> Void)?

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !placeholder.isEmpty else { return }
        guard let rect = placeholderRect else { return }

        let font = self.font ?? .systemFont(ofSize: NSFont.systemFontSize)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: NSColor.secondaryLabelColor,
        ]
        (placeholder as NSString).draw(with: rect,
                                       options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                                       attributes: attrs)
    }

    /// 占位符的绘制矩形。起点取 `textContainerOrigin` —— 它就是第一行文本（也就是
    /// 插入点那一行）的顶部，与光标同基线，不会像「TextEditor + 外层 padding」那样错位。
    var placeholderRect: NSRect? {
        let font = self.font ?? .systemFont(ofSize: NSFont.systemFontSize)
        let origin = textContainerOrigin
        let available = max(0, bounds.width - origin.x * 2)
        guard available > 1 else { return nil }
        let lineHeight = NSLayoutManager().defaultLineHeight(for: font)
        return NSRect(x: origin.x, y: origin.y,
                      width: available, height: ceil(lineHeight) + 2)
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { onFocusChange?(true) }
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { onFocusChange?(false) }
        return ok
    }

    /// 是否「换行」而不是「发送」。
    /// 约定：Enter 发送；Ctrl+Enter 换行（Shift/⌥+Enter 一并兼容，符合常见直觉）。
    static func wantsNewline(_ flags: NSEvent.ModifierFlags) -> Bool {
        let f = flags.intersection(.deviceIndependentFlagsMask)
        return f.contains(.control) || f.contains(.shift) || f.contains(.option)
    }

    /// Return 键的统一出口：返回 true 表示已换行，false 表示已触发发送。
    /// （抽成方法是为了让探针能不打键盘就验证两条分支）
    @discardableResult
    func newlineOrSend(flags: NSEvent.ModifierFlags) -> Bool {
        // 输入法组字中（marked text）按 Return 是「确认候选」，绝不能顺手把半截拼音发出去
        if hasMarkedText() {
            insertNewline(nil)
            return true
        }
        if Self.wantsNewline(flags) {
            insertNewline(nil)
            return true
        }
        if let onSend {
            onSend()
            return false
        }
        insertNewline(nil)
        return true
    }

    /// 排查用：把每次 doCommand 的选择器打到 stderr（`XSOLVE_COMPOSER_TRACE=1`）
    static var traceSelectors = false

    override func doCommand(by selector: Selector) {
        let name = NSStringFromSelector(selector)
        if Self.traceSelectors { NSLog("composer doCommand → %@", name) }

        // ⚠️ Ctrl+Return 走的不是 insertNewline:，AppKit 把它绑到 insertLineBreak:，
        // 而 insertLineBreak 插的是 U+2028（行分隔符）—— 既不是 `\n`，也不会被
        // trimmingCharacters 清掉，直接发给后端就成了脏字符。所以这三个统统按换行处理，
        // 并且统一插入真正的 LF。
        switch name {
        case "insertLineBreak:", "insertNewlineIgnoringFieldEditor:", "insertParagraphSeparator:":
            if hasMarkedText() {
                super.doCommand(by: selector)
            } else {
                insertNewline(nil)
                needsDisplay = true
            }
            return
        case "insertNewline:":
            // currentEvent 在个别路径（程序化派发/输入法）可能为空，退回当前键盘状态
            var flags = NSApp.currentEvent?.modifierFlags ?? []
            if flags.intersection(.deviceIndependentFlagsMask).isEmpty {
                flags = NSEvent.modifierFlags
            }
            newlineOrSend(flags: flags)
            needsDisplay = true
            return
        default:
            break
        }
        super.doCommand(by: selector)
    }
}

// MARK: - SwiftUI 封装

struct ComposerField: View {
    @Binding var text: String
    var placeholder: String = ""
    /// 固定高度（与 Web 端 textarea rows=2 对齐），超出内部滚动
    var height: CGFloat = 52
    var onSend: () -> Void

    @State private var focused = false

    var body: some View {
        ComposerTextViewRep(text: $text,
                            placeholder: placeholder,
                            focused: $focused,
                            onSend: onSend)
            .frame(height: height)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(nsColor: .textBackgroundColor).opacity(0.6))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(focused ? Color.brand.opacity(0.75) : Color.gray.opacity(0.28),
                            lineWidth: focused ? 1.5 : 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 8))
            .help("Enter 发送，Ctrl+Enter 换行")
    }
}

private struct ComposerTextViewRep: NSViewRepresentable {
    @Binding var text: String
    var placeholder: String
    @Binding var focused: Bool
    var onSend: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.focusRingType = .none
        scroll.scrollerStyle = .overlay
        scroll.verticalScrollElasticity = .allowed
        scroll.horizontalScrollElasticity = .none

        let tv = ComposerTextView()
        tv.delegate = context.coordinator
        tv.isEditable = true
        tv.isSelectable = true
        tv.isRichText = false
        tv.allowsUndo = true
        tv.drawsBackground = false
        tv.font = .preferredFont(forTextStyle: .body)
        tv.textColor = .labelColor
        tv.insertionPointColor = .labelColor
        tv.textContainerInset = NSSize(width: 10, height: 8)
        tv.textContainer?.lineFragmentPadding = 0
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.isAutomaticSpellingCorrectionEnabled = false
        tv.isContinuousSpellCheckingEnabled = false
        tv.isGrammarCheckingEnabled = false
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        tv.minSize = NSSize(width: 0, height: 0)
        tv.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude,
                            height: CGFloat.greatestFiniteMagnitude)
        tv.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        tv.textContainer?.widthTracksTextView = true
        tv.placeholder = placeholder
        tv.onSend = onSend
        tv.onFocusChange = { on in
            DispatchQueue.main.async { focused = on }
        }

        scroll.documentView = tv
        context.coordinator.textView = tv
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? ComposerTextView else { return }
        context.coordinator.parent = self
        tv.onSend = onSend
        if tv.placeholder != placeholder {
            tv.placeholder = placeholder
        }
        // 只在外部真的改了文本时回写：避免打字过程中重置选区 / 打断输入法
        if tv.string != text {
            let sel = tv.selectedRange()
            tv.string = text
            tv.setSelectedRange(NSRange(location: min(sel.location, (text as NSString).length), length: 0))
        }
        tv.needsDisplay = true
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextViewRep
        weak var textView: ComposerTextView?

        init(_ parent: ComposerTextViewRep) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            if parent.text != tv.string {
                parent.text = tv.string
            }
            tv.needsDisplay = true
        }
    }
}
