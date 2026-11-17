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

    private var ratio: CGFloat { natural.width / natural.height }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                // ① 框架先撑到可用空间（宽不超过自然宽、高不超过 220）
                .frame(maxWidth: natural.width, maxHeight: min(maxHeight, natural.height))
                // ② 再整体按图片比例收窄 —— 关键是这一步在 frame **之后**：
                //    否则框架仍是满宽、图片居中留白，边框就画成了一个大空框（截图里那种）。
                .aspectRatio(ratio, contentMode: .fit)
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
