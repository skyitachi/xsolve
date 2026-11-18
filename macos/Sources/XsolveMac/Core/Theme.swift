import SwiftUI

// MARK: - UI 主题（对齐 macOS HIG + Web 端设计令牌）
//
// 原则（与 Web 端 styles.css v2 同一套语言）：
// 1. 中性底 + 单一品牌色，只用在「可交互 / 当前状态」；
// 2. 用发丝描边区分区域，阴影只给浮层；
// 3. 字号阶梯：13 元信息 / 14 控件 / 15-16 正文；
// 4. macOS 13 没有 UnevenRoundedRectangle，气泡尾角用自写 Shape。

/// 聊天气泡底：大圆角 + 一侧 4pt 尾角
struct BubbleCorner: Shape {
    /// true = 用户气泡（右下小角）；false = AI 气泡（左下小角）
    var isUser: Bool
    var radius: CGFloat = 12
    var tail: CGFloat = 4

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let r = min(radius, rect.width / 2, rect.height / 2)
        let t = min(tail, r)
        p.move(to: CGPoint(x: rect.minX + r, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        p.addArc(center: CGPoint(x: rect.maxX - r, y: rect.minY + r), radius: r,
                 startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
        let br = isUser ? t : r
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - br))
        p.addArc(center: CGPoint(x: rect.maxX - br, y: rect.maxY - br), radius: br,
                 startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
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

/// 气泡背景：用户 = 品牌淡底 + 细描边（Web 端 .msg-user）；AI = 无气泡（正文式）
struct BubbleBackground: ViewModifier {
    var isUser: Bool

    func body(content: Content) -> some View {
        if isUser {
            content
                .background(
                    ZStack {
                        Color.brand.opacity(0.12)
                        BubbleCorner(isUser: true).stroke(Color.brand.opacity(0.18), lineWidth: 1)
                    }
                    .clipShape(BubbleCorner(isUser: true))
                )
        } else {
            content
        }
    }
}

extension View {
    /// 用户/AI 气泡样式（尾角 + 淡底）。AI 消息保持正文式，不套气泡。
    func chatBubble(isUser: Bool) -> some View { modifier(BubbleBackground(isUser: isUser)) }
}

// MARK: - 卡片 / 分区（HIG：发丝描边 + 轻阴影）

struct CardSurface: ViewModifier {
    var padding: CGFloat = 14
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color(nsColor: .controlBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.primary.opacity(0.07), lineWidth: 1)
            )
    }
}

extension View {
    func cardSurface(padding: CGFloat = 14) -> some View { modifier(CardSurface(padding: padding)) }
}

// MARK: - 面板标题（SF Symbol + 标题 + 尾部操作）

struct PanelHeader<Trailing: View>: View {
    let title: String
    let icon: String
    var subtitle: String? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.brand)
                .frame(width: 22, height: 22)
                .background(Color.brand.opacity(0.10), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            Text(title).font(.system(size: 13, weight: .semibold))
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 6)
            trailing()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(.bar)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.primary.opacity(0.07)).frame(height: 1)
        }
    }
}

extension PanelHeader where Trailing == EmptyView {
    init(title: String, icon: String, subtitle: String? = nil) {
        self.init(title: title, icon: icon, subtitle: subtitle) { EmptyView() }
    }
}

// MARK: - 空状态（macOS 13 没有 ContentUnavailableView）

struct EmptyHint: View {
    let icon: String
    let title: String
    var detail: String? = nil

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(.tertiary)
            Text(title).font(.callout).foregroundStyle(.secondary)
            if let detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }
}

// MARK: - 胶囊快捷语 / 标签

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

/// 轻量标签（主题、错误类型等）
struct SoftTag: View {
    let text: String
    var color: Color = .brand

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.12), in: Capsule())
    }
}

// MARK: - 语义背景

extension Color {
    /// 阅读区（聊天记录 / 列表）底色：与卡片形成对比
    static let chatLogBackground = Color(nsColor: .windowBackgroundColor)
    /// 文档正文区（题目 / 草稿外围）底色
    static let contentBackground = Color(nsColor: .textBackgroundColor)
}
