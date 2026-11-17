import SwiftUI
import AppKit

// MARK: - 题目原图（缩略显示 + 点击看大图）
//
// 为什么要限制尺寸：题目原图是学生上传的照片/截图，动辄 1000×1500。
// 直接 `.frame(maxWidth: .infinity)` 让它铺满整个题目区，一道题就吃掉一屏，
// 题目文字和做题区全被挤下去（截图里的情况）。
//
// 规则与 Web 端 `.figure-image-wrap img` 一致：
//   · 高度上限 220pt（max-height: 220px）
//   · 宽度不超出栏宽（max-width: 100%）
//   · 小图**不放大**（Web 端 img 只有 max-width，不会把小图拉大；SwiftUI 的
//     resizable 会，所以这里把自然尺寸也当成上限）
// 想看细节就点图，弹独立窗口按原图尺寸显示。

struct ProblemFigureImage: View {
    let image: NSImage
    /// 传 nil 就不显示说明行
    var caption: String? = "🖼️ 题目原图"
    /// 与 Web 端 `.figure-image-wrap img` 的 max-height 对齐
    var maxHeight: CGFloat = 220

    private var natural: NSSize {
        let s = image.size
        return (s.width > 1 && s.height > 1) ? s : NSSize(width: 400, height: 300)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // 尺寸由 FitBox 一次算准（见下方注释），这里只负责画和装饰
            FitBox(natural: natural, maxHeight: maxHeight) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
            }
            .cornerRadius(8)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.gray.opacity(0.25)))
            .onTapGesture { ImagePeekWindow.shared.show(image) }
            .help("点击查看大图")

            if let caption {
                HStack(spacing: 8) {
                    Text(caption).font(.caption).foregroundStyle(.secondary)
                    Button("查看大图") { ImagePeekWindow.shared.show(image) }
                        .font(.caption2)
                        .buttonStyle(.link)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - 等比缩放盒

/// 在「可用宽度 × 高度上限」里按图片比例放下子视图，**并且自己就是图片的尺寸**。
///
/// 为什么不能只靠 `frame(maxWidth:maxHeight:)` + `aspectRatio(ratio, .fit)`：
/// 题目区是 `ScrollView { VStack { … } }`，**竖直方向的高度提案是 nil**。此时
/// `aspectRatio` 只能拿宽度算尺寸（991×929 的图 → 560×526），外层的
/// `frame(maxHeight: 220)` 只把**布局框**压到 220 —— 图片本身仍按 560 宽绘制，
/// 于是被横向拉长 2.55 倍（实体机截图里那种「字被拉宽、三角形压扁」）。
///
/// 反过来的写法（`aspectRatio` 在外层）则会撑满宽度、图片居中留白，边框画成一个大空框。
/// 自定义 Layout 拿到的是**真实提案**，宽高一起算，返回的尺寸就是交给图片的尺寸，
/// 从结构上不可能变形，也不需要 GeometryReader 那种「先摆一遍、量到宽度再重摆」的两趟布局。
struct FitBox: Layout {
    var natural: NSSize
    var maxHeight: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let avail = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? .greatestFiniteMagnitude
        return fitted(available: avail)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize,
                       subviews: Subviews, cache: inout ()) {
        for s in subviews {
            s.place(at: bounds.origin,
                    proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
        }
    }

    private func fitted(available: CGFloat) -> CGSize {
        let maxW = min(natural.width, max(1, available))
        let maxH = min(natural.height, maxHeight)   // 小图不放大：自然尺寸也是上限
        // 只按「真正起限制作用的那一边」缩放，另一边由比例算出 —— 这样宽高比是精确的
        if maxH / natural.height <= maxW / natural.width {
            return CGSize(width: max(1, (natural.width * maxH / natural.height).rounded()),
                          height: max(1, maxH))
        }
        return CGSize(width: max(1, maxW),
                      height: max(1, (natural.height * maxW / natural.width).rounded()))
    }
}

// MARK: - 原图窗口

/// 独立窗口而不是 sheet：题目区已经挂了五个 sheet（TutorSheets），再加一个容易互相顶掉
final class ImagePeekWindow: NSObject, NSWindowDelegate {
    static let shared = ImagePeekWindow()

    private var window: NSWindow?

    func show(_ image: NSImage, title: String = "题目原图") {
        window?.close()

        let s = image.size
        let natural = (s.width > 1 && s.height > 1) ? s : NSSize(width: 480, height: 360)
        // 不超过屏幕可用区域，也不把小图强行放大
        let screen = (NSScreen.main?.visibleFrame.size) ?? NSSize(width: 1100, height: 800)
        let fit = min(1, min((screen.width - 80) / natural.width, (screen.height - 120) / natural.height))
        let size = NSSize(width: max(240, (natural.width * fit).rounded()),
                          height: max(180, (natural.height * fit).rounded()))

        let w = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                         styleMask: [.titled, .closable, .resizable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = title
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.center()

        let iv = NSImageView(image: image)
        iv.imageScaling = .scaleProportionallyUpOrDown
        iv.imageFrameStyle = .none
        iv.frame = NSRect(origin: .zero, size: size)
        iv.autoresizingMask = [.width, .height]
        iv.wantsLayer = true
        iv.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        w.contentView = iv

        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window = w
    }

    func windowWillClose(_ notification: Notification) {
        window = nil
    }
}
