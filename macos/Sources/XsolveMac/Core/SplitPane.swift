import SwiftUI
import AppKit

// MARK: - 可拖动的两栏布局
//
// 为什么不用 `HSplitView`：它把分隔位置交给 NSSplitView 自己记，而两个子视图又各自带
// `.frame(minWidth:idealWidth:maxWidth:)` —— 每次布局都用 idealWidth 重算，拖动改的值
// 立刻被覆盖，表现就是「分隔条拖不动」。改成自己算：左栏宽度是个显式数值（写进
// @AppStorage），分隔条只改这个数，布局就是 `left(w) | 分隔条 | right(剩余)`。
//
// 分隔条用 AppKit 视图而不是 SwiftUI `DragGesture`：
//   · 光标形状靠 `resetCursorRects`（SwiftUI 没有 cursor 修饰符，onHover 里 set() 会打架）
//   · 拖动由自己收 mouseDown/Dragged/Up，探针能直接派发事件验证，不依赖手势识别器
//
// ⚠️ 这里的字段全是 CGFloat / 简单闭包，不要写成 `(() -> (min: CGFloat, max: CGFloat))?`
// 那种形状 —— 试过，Swift 类型检查器在这个文件上直接卡死 26 分钟（-Onone 也会）。

/// 左 | 分隔条 | 右
struct SplitPane<Left: View, Right: View>: View {
    @Binding var leftWidth: CGFloat
    var minLeft: CGFloat
    var minRight: CGFloat
    /// 双击分隔条复位到这个宽度
    var defaultWidth: CGFloat

    @ViewBuilder var left: () -> Left
    @ViewBuilder var right: () -> Right

    /// 分隔条命中区宽度：1pt 的线太难点，做 9pt（与 Web 端 9px 分割条一致）
    private let handleWidth: CGFloat = 9

    var body: some View {
        GeometryReader { geo in
            // 每次布局按当前可用宽度收紧一次：窗口缩小时左栏不会把右栏挤没
            let maxLeft: CGFloat = max(minLeft, geo.size.width - minRight - handleWidth)
            let w: CGFloat = min(max(leftWidth, minLeft), maxLeft)

            HStack(spacing: 0) {
                left()
                    .frame(width: w)

                SplitHandle(width: w,
                            minWidth: minLeft,
                            maxWidth: maxLeft,
                            commit: { newWidth in leftWidth = newWidth },
                            reset: { leftWidth = min(max(defaultWidth, minLeft), maxLeft) })
                    .frame(width: handleWidth)

                right()
                    .frame(maxWidth: .infinity)
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }
}

// MARK: - 分隔条（AppKit）

struct SplitHandle: NSViewRepresentable {
    var width: CGFloat
    var minWidth: CGFloat
    var maxWidth: CGFloat
    var commit: (CGFloat) -> Void
    var reset: () -> Void

    func makeNSView(context: Context) -> SplitHandleView {
        let v = SplitHandleView()
        // NSView 侧的提示气泡（SwiftUI 的 .help 加在 representable 上不一定生效）
        v.toolTip = "拖动调整左右栏宽度，双击复位"
        return v
    }

    func updateNSView(_ v: SplitHandleView, context: Context) {
        v.width = width
        v.minWidth = minWidth
        v.maxWidth = maxWidth
        v.commit = commit
        v.reset = reset
    }
}

final class SplitHandleView: NSView {
    var width: CGFloat = 0
    var minWidth: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    var commit: ((CGFloat) -> Void)?
    var reset: (() -> Void)?

    private var hovered = false { didSet { needsDisplay = true } }
    private var tracking: NSTrackingArea?
    private var startWidth: CGFloat = 0
    private var startX: CGFloat = 0

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { false }

    // 光标：分隔条上显示「左右拖动」
    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .resizeLeftRight)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds,
                                  options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount >= 2 {
            reset?()
            return
        }
        startWidth = width
        // ⚠️ 必须用**窗口坐标**，不能用 `convert(..., from: nil)` 换成本地坐标：
        // 分隔条自己会随拖动一起移动，本地坐标系的 x 会被「视图移动的距离」抵消掉，
        // 算出来的位移只有实际的一半（拖到一半就像被粘住）。窗口坐标不跟视图跑。
        startX = event.locationInWindow.x
        if trace { NSLog("split down startWidth=%.1f startX=%.1f", startWidth, startX) }
    }

    override func mouseDragged(with event: NSEvent) {
        let x = event.locationInWindow.x
        var w = startWidth + (x - startX)
        w = min(max(w, minWidth), maxWidth)
        width = w
        if trace { NSLog("split drag x=%.1f -> w=%.1f (start=%.1f startX=%.1f)", x, w, startWidth, startX) }
        commit?(w)
    }

    private var trace: Bool {
        ProcessInfo.processInfo.environment["XSOLVE_SPLIT_TRACE"] == "1"
    }

    override func draw(_ dirtyRect: NSRect) {
        // 视觉：一条 hairline，悬停时染成主色并加粗
        let color: NSColor
        if hovered {
            color = NSColor(srgbRed: 0x4F / 255.0, green: 0x46 / 255.0, blue: 0xE5 / 255.0, alpha: 1)
        } else {
            color = .separatorColor
        }
        color.setFill()
        let lineWidth: CGFloat = hovered ? 2 : 1
        NSRect(x: (bounds.width - lineWidth) / 2, y: 0,
               width: lineWidth, height: bounds.height).fill()
    }
}
