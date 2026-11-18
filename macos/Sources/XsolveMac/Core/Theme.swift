import SwiftUI

// MARK: - UI 主题（与 Web 端 styles.css 的设计令牌对齐）
//
// Web 端令牌：--brand #4f46e5 / --violet #7c3aed / 尾角 4px / 圆角 12px。
// macOS 13 没有 UnevenRoundedRectangle（macOS 14+），气泡尾角用自写 Shape。

/// 聊天气泡底：大圆角 + 一侧 4pt 尾角（对应 Web 端 border-bottom-?-radius: 4px）
struct BubbleCorner: Shape {
    /// true = 用户气泡（右下小角）；false = AI 气泡（左下小角）
    var isUser: Bool
    var radius: CGFloat = 12
    var tail: CGFloat = 4

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let r = min(radius, rect.width / 2, rect.height / 2)
        let t = min(tail, r)
        // 左上 → 右上 → 右下 → 左下，逐角带半径
        p.move(to: CGPoint(x: rect.minX + r, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        p.addArc(center: CGPoint(x: rect.maxX - r, y: rect.minY + r), radius: r,
                 startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
        // 右下：用户气泡用小尾角
        let br = isUser ? t : r
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - br))
        p.addArc(center: CGPoint(x: rect.maxX - br, y: rect.maxY - br), radius: br,
                 startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        // 左下：AI 气泡用小尾角
        let bl = isUser ? r : t
        p.addLine(to: CGPoint(x: rect.minX + bl, y: rect.maxY))
        p.addArc(center: CGPoint(x: rect.minX + bl, y: rect.maxY - bl), radius: bl,
                 startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        p.addArc(center: CGPoint(x: rect.minX + r, y: rect.minY + r), radius: r,
                 startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        p.closeSubpath()
        return p
    }
}

/// 气泡背景修饰：填充色（或渐变）+ 可选描边 + 柔和阴影
struct BubbleBackground: ViewModifier {
    var isUser: Bool

    func body(content: Content) -> some View {
        if isUser {
            content
                .background(
                    ZStack {
                        LinearGradient(colors: [Color.brand, Color(hex: 0x6D28D9)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                        BubbleCorner(isUser: true).stroke(Color.white.opacity(0.12), lineWidth: 1)
                    }
                    .clipShape(BubbleCorner(isUser: true))
                    .shadow(color: Color.brand.opacity(0.25), radius: 4, y: 2)
                )
        } else {
            content
                .background(
                    ZStack {
                        Color(nsColor: .controlBackgroundColor)
                        BubbleCorner(isUser: false).stroke(Color.primary.opacity(0.08), lineWidth: 1)
                    }
                    .clipShape(BubbleCorner(isUser: false))
                    .shadow(color: Color.black.opacity(0.05), radius: 2, y: 1)
                )
        }
    }
}

extension View {
    /// 用户/AI 气泡样式（尾角 + 渐变/卡片化）
    func chatBubble(isUser: Bool) -> some View { modifier(BubbleBackground(isUser: isUser)) }
}

// MARK: - 胶囊快捷语按钮（对应 Web 端 .chat-actions .quick 的胶囊小按钮）

struct CapsuleChipButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .foregroundStyle(Color.brand)
            .background(
                Capsule().fill(Color.brand.opacity(configuration.isPressed ? 0.22 : 0.10))
            )
            .overlay(Capsule().strokeBorder(Color.brand.opacity(0.18)))
            .opacity(enabled ? 1 : 0.5)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == CapsuleChipButtonStyle {
    static var capsuleChip: CapsuleChipButtonStyle { CapsuleChipButtonStyle() }
}

// MARK: - 聊天滚动区底色（对应 Web 端 chat-log #f8f9fc；深色外观自动变暗）

extension Color {
    /// 聊天记录区底色：浅色下比面板底色略灰、带一点冷调，把白色气泡衬托出来
    static let chatLogBackground = Color(nsColor: .windowBackgroundColor)
}
