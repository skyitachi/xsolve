import SwiftUI

// MARK: - 我的孩子（my-children.html，家长/管理员）

struct MyChildrenView: View {
    @EnvironmentObject var model: AppModel
    let api = APIClient.shared

    @State private var children: [Child] = []
    @State private var inviteOutput: String?
    @State private var bindOutput: String?
    @State private var bindCodeInput = ""
    @State private var errorText: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("👨‍👩‍👧 我的孩子").font(.title2.bold())

                if let e = errorText { Text(e).foregroundStyle(.red) }

                // 绑定新区
                VStack(alignment: .leading, spacing: 10) {
                    Text("绑定孩子").font(.headline)
                    HStack {
                        TextField("输入学生绑定码（孩子在账户菜单生成）", text: $bindCodeInput)
                            .textFieldStyle(.roundedBorder)
                        Button("绑定") { Task { await bind() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(bindCodeInput.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    if let b = bindOutput { Text(b).font(.footnote).foregroundStyle(.secondary) }
                }
                .padding(14)
                .background(Color.gray.opacity(0.05)).cornerRadius(12)

                // 孩子卡片
                if children.isEmpty {
                    Text("尚未绑定孩子。让孩子在其账户菜单里生成「绑定码」，然后在上面的输入框绑定。")
                        .foregroundStyle(.secondary)
                        .padding(14)
                        .frame(maxWidth: .infinity)
                        .background(Color.gray.opacity(0.05)).cornerRadius(12)
                }
                ForEach(children) { c in
                    ChildCard(child: c, onUnbind: { await unbind(c) })
                }

                // 邀请码（孩子注册用）
                VStack(alignment: .leading, spacing: 8) {
                    Text("注册邀请码").font(.headline)
                    Text("孩子注册账号时填写，7 天内有效。").font(.footnote).foregroundStyle(.secondary)
                    HStack {
                        Button("生成邀请码") { Task { await genInvite() } }
                        if let i = inviteOutput { Text(i).font(.callout).textSelection(.enabled) }
                        Spacer()
                    }
                }
                .padding(14)
                .background(Color.gray.opacity(0.05)).cornerRadius(12)
            }
            .padding(18)
        }
        .onAppear { Task { await load() } }
    }

    private func load() async {
        do {
            let r: FamilyChildrenResp = try await api.request("GET", "api/family/children", body: nil as [String: String]?)
            children = r.children
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func genInvite() async {
        do {
            let r: InviteResp = try await api.request("POST", "api/auth/invite", body: Empty())
            inviteOutput = "邀请码：\(r.code)（让孩子注册时填写）"
        } catch {
            inviteOutput = "失败：\(error.localizedDescription)"
        }
    }

    private func bind() async {
        do {
            let r = try await api.requestOK("POST", "api/family/bind", body: ["code": bindCodeInput.uppercased()])
            bindOutput = r["already_bound"]?.boolValue == true
                ? "该孩子已经绑定过了（绑定码已核销）"
                : "绑定成功 ✅"
            bindCodeInput = ""
            if let me = try? await api.me() { model.user = me }
            await load()
        } catch {
            bindOutput = "失败：\(error.localizedDescription)"
        }
    }

    private func unbind(_ c: Child) async {
        _ = try? await api.requestOK("DELETE", "api/family/children/\(c.id)", body: nil as [String: String]?)
        if let me = try? await api.me() { model.user = me }
        await load()
    }
}

private struct ChildCard: View {
    let child: Child
    let onUnbind: () async -> Void
    @State private var sessions: [SessionRow] = []
    @State private var showSessions = false
    @State private var bindOutput: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "person.crop.circle.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(Color.brand)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(child.display_name ?? child.username).font(.headline)
                        if let r = child.relation { Tag(r) }
                    }
                    Text(child.username).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let s = child.stats {
                    HStack(spacing: 14) {
                        MiniStat("会话", "\(s.session_count ?? 0)")
                        MiniStat("作答", "\(s.attempt_count ?? 0)")
                        MiniStat("正确率", "\(s.rate ?? 0)%")
                        MiniStat("平均掌握", s.avg_mastery.map { "\($0)%" } ?? "—")
                        if let lv = s.level { Tag(lv) }
                    }
                }
                Button("解绑", role: .destructive) { Task { await onUnbind() } }
                    .controlSize(.small)
            }

            HStack {
                Button {
                    Task { await loadSessions() }
                    showSessions.toggle()
                } label: {
                    Label(showSessions ? "收起会话" : "查看学习会话", systemImage: "list.bullet.rectangle")
                }
                .controlSize(.small)

                Button("🔗 生成绑定码（给另一位家长）") { Task { await genBindCode() } }
                    .controlSize(.small)

                if let b = bindOutput { Text(b).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                Spacer()
            }

            if showSessions {
                Table(sessions) {
                    TableColumn("会话") { Text($0.title ?? "未命名") }
                    TableColumn("角色") { Text($0.role ?? "") }.width(60)
                    TableColumn("更新") { Text(fmtDate($0.updatedAt)) }.width(110)
                }
                .frame(height: 160)
            }
        }
        .padding(14)
        .background(Color.gray.opacity(0.05)).cornerRadius(12)
    }

    private func MiniStat(_ k: String, _ v: String) -> some View {
        VStack(spacing: 1) {
            Text(v).font(.callout.bold())
            Text(k).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func loadSessions() async {
        if let r: ChildSessionsResp = try? await APIClient.shared.request("GET", "api/family/children/\(child.id)/sessions", body: nil as [String: String]?) {
            sessions = r.sessions
        }
    }

    private func genBindCode() async {
        do {
            let r: InviteResp = try await APIClient.shared.request("POST", "api/family/bind-codes", body: ["studentId": child.id])
            bindOutput = "绑定码：\(r.code)（7 天内有效）"
        } catch {
            bindOutput = "失败：\(error.localizedDescription)"
        }
    }
}
