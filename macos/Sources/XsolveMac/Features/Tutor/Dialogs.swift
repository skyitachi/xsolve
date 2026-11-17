import SwiftUI

// MARK: - AI 出题确认弹窗（proposal-dialog）

struct ProposalDialog: View {
    @ObservedObject var state: TutorState
    let problem: ProposedProblem
    @State private var showHints = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("🎯 AI 助教出了一道新题").font(.headline)
            Text("是否替换当前题目并开始挑战？").font(.footnote).foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 8) {
                Text(problem.topic ?? "未分类")
                    .font(.caption)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Color.brand.opacity(0.12))
                    .clipShape(Capsule())
                RichText(text: problem.text ?? "")
                    .padding(10)
                    .background(Color.gray.opacity(0.06))
                    .cornerRadius(8)
                // 与题目区同一条优先级：原图（学生上传的）优先，其次才是几何示意图
                if let fig = problem.figureImage, let img = ImageUtil.image(fromDataURL: fig) {
                    Image(nsImage: img).resizable().scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: 220)
                        .cornerRadius(8)
                } else if let fig = problem.figure, fig.type != "image" {
                    FigureView(figure: fig)
                }
                if let hints = problem.hints, !hints.isEmpty {
                    DisclosureGroup(isExpanded: $showHints) {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(hints.enumerated()), id: \.offset) { i, h in
                                Text("\(i + 1). \(h)").font(.footnote)
                            }
                        }
                    } label: {
                        Text("查看提示（可选）").font(.footnote)
                    }
                }
            }

            HStack {
                Button("取消") { Task { await state.cancelProposal() } }
                Spacer()
                Button("替换并开始做这题") { Task { await state.acceptProposal() } }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(18)
        // 只固定宽度、高度交给内容：原来写死 480 高，短题下面一大片空白，
        // 看起来像内容没加载完
        .frame(width: 520)
    }
}

// MARK: - 删除确认弹窗（delete-dialog，手动/AI 共用）

struct DeleteConfirmDialog: View {
    @ObservedObject var state: TutorState
    let problem: ProposedProblem
    let fromAI: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("🗑️ 确认删除题目？").font(.headline)
            Text("删除后无法恢复，确定要删除这道题吗？").font(.footnote).foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 8) {
                Text(problem.topic ?? "未分类")
                    .font(.caption)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Color.red.opacity(0.12))
                    .clipShape(Capsule())
                    .foregroundStyle(.red)
                Text(problem.text ?? "")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .lineLimit(4)
                    .padding(10)
                    .background(Color.red.opacity(0.05))
                    .cornerRadius(8)
            }

            HStack {
                Button("取消") { Task { await state.cancelDelete() } }
                Spacer()
                Button("确认删除") { Task { await state.acceptDelete() } }
                    .keyboardShortcut(.defaultAction)
                    .tint(.red)
            }
        }
        .padding(18)
        .frame(width: 480, height: 320)
    }
}

// MARK: - 关于弹窗（settings-dialog）

struct AboutDialog: View {
    /// 由父视图直接翻 showAbout 状态位，不依赖 sheet 的环境 dismiss
    var onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("关于").font(.headline)
            Text("AI 助教由本地 Claude Code (claude-agent-sdk) 驱动。每打开一次应用会创建一个 Claude Code session。")
                .font(.callout)
            Text("认证沿用服务器的登录会话（httpOnly Cookie）。")
                .font(.footnote).foregroundStyle(.secondary)
            Text("服务器地址：\(APIClient.shared.baseURL)")
                .font(.footnote).foregroundStyle(.secondary)
            Text("有问题可直接在右侧聊天里告诉 AI 助教。")
                .font(.footnote).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("好") { onClose() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(18)
        .frame(width: 420)
        // 兜底：Esc 也能关，避免只有一个按钮时用户无处可退
        .background(
            Button("") { onClose() }
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        )
    }
}
