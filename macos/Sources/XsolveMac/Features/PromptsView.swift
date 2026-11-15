import SwiftUI

// MARK: - Prompt 版本管理（prompts.html，管理员）

struct PromptsView: View {
    let api = APIClient.shared
    @State private var role = ""
    @State private var roles: [String] = []
    @State private var versions: [PromptVersion] = []
    @State private var selected: PromptVersion?
    @State private var fullContent: PromptVersion?
    @State private var showNew = false
    @State private var message: String?

    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                Picker("角色", selection: $role) {
                    ForEach(roles, id: \.self) { Text($0) }
                }
                .pickerStyle(.segmented)
                .padding(10)

                List(selection: Binding(get: { selected?.id }, set: { v in
                    selected = versions.first { $0.id == v }
                    Task { await loadFull() }
                })) {
                    ForEach(versions) { v in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text("v\(v.version ?? 0)").font(.callout.bold())
                                    if v.is_active == true {
                                        Text("使用中").font(.caption2.bold())
                                            .padding(.horizontal, 5).padding(.vertical, 1)
                                            .background(Color.green.opacity(0.15)).clipShape(Capsule())
                                            .foregroundStyle(.green)
                                    }
                                }
                                let desc: String = {
                                    if let d = v.description, !d.isEmpty { return d }
                                    return v.content_preview ?? ""
                                }()
                                Text(desc)
                                    .font(.caption)
                                    .lineLimit(1)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(fmtDate(v.created_at)).font(.caption2).foregroundStyle(.secondary)
                        }
                        .tag(v.id)
                        .padding(.vertical, 2)
                    }
                }
                .listStyle(.plain)

                if let m = message {
                    Text(m).font(.caption).foregroundStyle(.secondary).padding(8)
                }

                HStack {
                    Button("新建版本") { showNew = true }
                    Spacer()
                    Button("刷新") { Task { await load() } }
                }
                .padding(10)
            }
            .frame(width: 360)

            // 内容区
            Group {
                if let f = fullContent {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack {
                            Text("角色 \(f.role) · v\(f.version ?? 0)\(f.is_active == true ? "（使用中）" : "")")
                                .font(.headline)
                            Spacer()
                            if f.is_active != true {
                                Button("激活此版本") { Task { await activate(f) } }
                                Button("删除", role: .destructive) { Task { await delete(f) } }
                            }
                        }
                        .padding(12)
                        Divider()
                        ScrollView {
                            Text(f.content ?? "")
                                .font(.system(size: 12, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(12)
                        }
                    }
                } else {
                    Text("选择左侧版本查看完整 Prompt").frame(maxWidth: .infinity, maxHeight: .infinity)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minWidth: 420)
        }
        .sheet(isPresented: $showNew) {
            NewPromptSheet(role: role.isEmpty ? "student" : role) {
                Task { await load() }
            }
        }
        .onAppear { Task { await load() } }
        .onChange(of: role) { _ in Task { await load() } }
    }

    private func load() async {
        if roles.isEmpty, let rs: [String] = try? await api.request("GET", "api/prompts/roles/list", body: nil as [String: String]?) {
            roles = rs
            if role.isEmpty { role = rs.first ?? "student" }
        }
        let r: [PromptVersion]? = try? await api.request("GET", "api/prompts", query: role.isEmpty ? nil : ["role": role], body: nil as [String: String]?)
        versions = r ?? []
        selected = versions.first { $0.is_active == true } ?? versions.first
        await loadFull()
    }

    private func loadFull() async {
        guard let s = selected else { fullContent = nil; return }
        fullContent = try? await api.request("GET", "api/prompts/\(s.id)", body: nil as [String: String]?)
    }

    private func activate(_ v: PromptVersion) async {
        _ = try? await api.requestOK("POST", "api/prompts/\(v.id)/activate", body: Empty())
        message = "已激活，新建会话将使用此 prompt"
        await load()
    }

    private func delete(_ v: PromptVersion) async {
        do {
            _ = try await api.requestOK("DELETE", "api/prompts/\(v.id)", body: nil as [String: String]?)
            message = "已删除"
        } catch {
            message = error.localizedDescription
        }
        await load()
    }
}

private struct NewPromptSheet: View {
    let role: String
    let onDone: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var content = ""
    @State private var desc = ""
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("新建 Prompt 版本（角色：\(role)）").font(.headline)
            TextField("版本描述（如：更强调引导式提问）", text: $desc)
                .textFieldStyle(.roundedBorder)
            TextEditor(text: $content)
                .font(.system(size: 12, design: .monospaced))
                .padding(4)
                .background(Color.gray.opacity(0.08)).cornerRadius(8)
            if let e = errorText { Text(e).foregroundStyle(.red).font(.footnote) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button("创建") {
                    Task {
                        do {
                            _ = try await APIClient.shared.requestOK("POST", "api/prompts", body: [
                                "role": role, "content": content, "description": desc,
                            ] as [String: String])
                            onDone()
                            dismiss()
                        } catch { errorText = error.localizedDescription }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(content.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(16)
        .frame(width: 560, height: 480)
    }
}
