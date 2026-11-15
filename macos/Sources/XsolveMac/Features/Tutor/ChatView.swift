import SwiftUI

// MARK: - AI 助教面板（chat-log + 状态指示 + 快捷语 + 输入区）

struct ChatPanel: View {
    @ObservedObject var state: TutorState
    @EnvironmentObject var model: AppModel
    @State private var input = ""

    private let quickPrompts: [(String, String)] = [
        ("要提示", "给我一个提示，但不要直接告诉我答案"),
        ("检查过程", "请检查我刚才写在草稿区的过程"),
        ("水平测评", "请评估我的解题水平，并指出我哪里需要加强"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            // 标题栏：模式切换 + 状态 + 清空/新建
            HStack(spacing: 8) {
                Label("🤖 AI 助教", systemImage: "bubble.left.and.bubble.right.fill")
                    .font(.headline)

                // 学生账号锁学生模式；家长锁家长模式；管理员可切换（与 Web 端 applyRoleUI 一致）
                if model.user?.role == "admin" {
                    Picker("", selection: Binding(
                        get: { state.mode },
                        set: { newValue in Task { await state.switchMode(newValue) } })) {
                        Text("学生版").tag("student")
                        Text("家长版").tag("parent")
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 150)
                }

                Spacer()

                AiStatusBadge(status: state.status)

                Button { Task { await state.clearHistory() } } label: {
                    Image(systemName: "paintbrush")
                }
                .help("清空当前对话历史（保留会话）")

                Button { Task { await state.newChatOverride() } } label: {
                    Image(systemName: "sparkles")
                }
                .help("新建对话（覆盖当前会话）")
            }
            .padding(.horizontal, 12).padding(.vertical, 8)

            Divider()

            // 聊天记录
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(state.entries) { entry in
                            ChatEntryView(entry: entry)
                                .id(entry.id)
                        }
                    }
                    .padding(12)
                }
                .onChange(of: state.entries.count) { _ in
                    if let last = state.entries.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }

            Divider()

            // 快捷语
            HStack(spacing: 6) {
                ForEach(quickPrompts, id: \.0) { label, prompt in
                    Button(label) {
                        state.userMsg(prompt)
                        Task { await state.runTurn(prompt) }
                    }
                    .controlSize(.small)
                    .buttonStyle(.bordered)
                }
            }
            .padding(.horizontal, 12).padding(.top, 6)

            // 输入区
            HStack(alignment: .bottom, spacing: 8) {
                TextEditor(text: $input)
                    .font(.body)
                    .frame(height: 52)
                    .padding(4)
                    .background(Color.gray.opacity(0.08))
                    .cornerRadius(8)
                    .overlay(alignment: .topLeading) {
                        if input.isEmpty {
                            Text("问我任何问题…")
                                .foregroundColor(.secondary)
                                .padding(10)
                                .allowsHitTesting(false)
                        }
                    }

                if state.turnInFlight {
                    Button {
                        state.cancelTurn()
                    } label: {
                        Label("停止", systemImage: "stop.fill")
                    }
                    .controlSize(.large)
                } else {
                    Button {
                        send()
                    } label: {
                        Label("发送", systemImage: "paperplane.fill")
                    }
                    .controlSize(.large)
                    .buttonStyle(.borderedProminent)
                    .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(12)
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        input = ""
        state.userMsg(text)
        Task { await state.runTurn(text) }
    }
}

// MARK: - 状态徽标

struct AiStatusBadge: View {
    @ObservedObject var status: AiStatus

    private var color: Color {
        switch status.kind {
        case .idle: return .secondary
        case .thinking: return Color(hex: 0xF59E0B)
        case .tool: return Color(hex: 0x8B5CF6)
        case .streaming: return Color.brand
        case .done: return .green
        case .error: return .red
        case .stalled: return .orange
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(status.text).font(.caption)
            if status.kind == .thinking || status.kind == .tool || status.kind == .streaming {
                Text("\(status.elapsed)s").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(color.opacity(0.1))
        .clipShape(Capsule())
    }
}

// MARK: - 单条消息渲染

struct ChatEntryView: View {
    let entry: ChatEntry

    var body: some View {
        switch entry {
        case .user(let text, let imageData):
            HStack(alignment: .top, spacing: 8) {
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    if !text.isEmpty {
                        RichText(text: text, isUserInput: true)
                            .padding(10)
                            .background(Color.brand.opacity(0.12))
                            .cornerRadius(12)
                    }
                    if let d = imageData, let img = ImageUtil.image(fromDataURL: d) {
                        Image(nsImage: img)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: 220)
                            .cornerRadius(8)
                    }
                }
            }
        case .system(let text):
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .multilineTextAlignment(.center)
        case .error(let text):
            HStack(alignment: .top, spacing: 8) {
                Text("⚠️").font(.title3)
                VStack(alignment: .leading, spacing: 2) {
                    Text("出错了").font(.callout.bold())
                    Text(text).font(.footnote).foregroundStyle(.red).textSelection(.enabled)
                }
                Spacer()
            }
            .padding(10)
            .background(Color.red.opacity(0.08))
            .cornerRadius(10)
        case .ai(let block):
            AiMessageView(block: block)
        case .tool(let card):
            ToolCardView(card: card)
        case .diagram(let url, let title):
            DiagramCard(url: url, title: title)
        }
    }
}

private struct AiMessageView: View {
    @ObservedObject var block: AiTextBlock

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                RichText(text: block.raw)
                    .padding(10)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .cornerRadius(12)
                    .overlay(alignment: .bottomTrailing) {
                        if block.streaming {
                            Text("▍").foregroundStyle(Color.brand)
                        }
                    }
                if !block.streaming && !block.raw.isEmpty {
                    Button {
                        copyToPasteboard(block.raw)
                    } label: {
                        Label("复制", systemImage: "doc.on.doc")
                            .font(.caption2)
                    }
                    .buttonStyle(.link)
                    .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
    }
}

private struct ToolCardView: View {
    @ObservedObject var card: ToolCardState
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(card.label).font(.callout.bold())
                Spacer()
                if card.running {
                    HStack(spacing: 4) {
                        ProgressView().controlSize(.mini)
                        Text("运行中…").font(.caption)
                    }
                } else {
                    Text(card.isError ? "失败" : "完成")
                        .font(.caption)
                        .foregroundStyle(card.isError ? .red : .green)
                }
            }
            if !card.args.isEmpty {
                Text(card.args)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(expanded ? nil : 2)
            }
            if let r = card.result {
                Text(r)
                    .font(.system(size: 10, design: .monospaced))
                    .lineLimit(expanded ? 200 : 4)
                    .foregroundStyle(card.isError ? Color.red : Color.primary)
                    .textSelection(.enabled)
            }
            Button(expanded ? "收起" : "展开") { expanded.toggle() }
                .font(.caption2)
                .buttonStyle(.link)
        }
        .padding(10)
        .background(Color(hex: 0x6366F1).opacity(0.06))
        .cornerRadius(10)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(hex: 0x6366F1).opacity(0.2)))
    }
}

private struct DiagramCard: View {
    let url: String
    let title: String
    @State private var height: CGFloat = 360

    private var fullURL: URL? {
        var s = APIClient.shared.baseURL
        while s.hasSuffix("/") { s.removeLast() }
        return URL(string: s + (url.hasPrefix("/") ? url : "/" + url))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("📐 \(title)").font(.callout.bold())
                Spacer()
                if let u = fullURL {
                    Button("在新窗口打开 ↗") { openInBrowser(u) }
                        .font(.caption)
                        .buttonStyle(.link)
                }
            }
            if let u = fullURL {
                WebViewRep(url: u)
                    .frame(height: height)
                    .cornerRadius(8)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.gray.opacity(0.3)))
                HStack(spacing: 12) {
                    Slider(value: $height, in: 240...900)
                    Text("\(Int(height))px").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
        }
        .padding(10)
        .background(Color.brand.opacity(0.05))
        .cornerRadius(10)
    }
}
