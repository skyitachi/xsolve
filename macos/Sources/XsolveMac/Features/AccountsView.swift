import SwiftUI

// MARK: - 账号管理（accounts.html，管理员）

struct AccountsView: View {
    @EnvironmentObject var model: AppModel
    let api = APIClient.shared

    @State private var users: [User] = []
    @State private var totals: UsersResp.Totals?
    @State private var message: String?
    @State private var showNew = false
    @State private var showAudit = false

    var body: some View {
        VStack(spacing: 0) {
            // 统计条
            if let t = totals {
                HStack(spacing: 16) {
                    Tag("全部 \(t.all)")
                    Tag("管理员 \(t.admins)")
                    Tag("学生 \(t.students)")
                    Tag("家长 \(t.parents)")
                    Tag("游客 \(t.guests)")
                    Spacer()
                    Button("清理到期游客") { Task { await purgeGuests() } }
                    Button("审计日志") { showAudit = true }
                    Button("新建账号") { showNew = true }
                        .buttonStyle(.borderedProminent)
                }
                .padding(12)
                Divider()
            }
            if let m = message {
                Text(m).font(.footnote).foregroundStyle(.secondary).padding(6)
            }

            Table(users) {
                TableColumn("用户名") { Text($0.username) }.width(120)
                TableColumn("昵称") { Text($0.display_name ?? "—") }.width(110)
                TableColumn("角色") { Text(roleText($0)) }.width(80)
                TableColumn("状态") { row in
                    if row.status == "disabled" { Text("已停用").foregroundStyle(.red) }
                    else { Text("正常").foregroundStyle(.green) }
                }.width(60)
                TableColumn("会话") { Text("\($0.session_count ?? 0)") }.width(50)
                TableColumn("作答") { Text("\($0.attempt_count ?? 0)") }.width(50)
                TableColumn("正确") { Text("\($0.correct_count ?? 0)") }.width(50)
                TableColumn("孩子") { Text("\($0.child_count ?? 0)") }.width(50)
                TableColumn("最近登录") { Text(fmtDate($0.last_login_at)) }.width(100)
                TableColumn("操作") { row in
                    HStack(spacing: 4) {
                        Button("改密") { Task { await resetPassword(row) } }.controlSize(.small)
                        Button(row.status == "disabled" ? "启用" : "停用") {
                            Task { await setStatus(row, row.status != "disabled") }
                        }.controlSize(.small)
                        Button(row.is_admin ? "撤管" : "设管") {
                            Task { await setAdmin(row, !row.is_admin) }
                        }.controlSize(.small)
                        Menu("⋯") {
                            Button("改昵称") { Task { await rename(row) } }
                            Button("删除账号", role: .destructive) { Task { await delete(row) } }
                        }
                        .controlSize(.small)
                        .fixedSize()
                    }
                }.width(300)
            }
        }
        .sheet(isPresented: $showNew) {
            NewUserSheet { msg in
                message = msg
                Task { await load() }
            }
        }
        .sheet(isPresented: $showAudit) {
            AuditSheet()
        }
        .onAppear { Task { await load() } }
    }

    private func roleText(_ u: User) -> String {
        if u.is_admin { return "管理员" }
        return u.role == "parent" ? "家长" : "学生"
    }

    private func load() async {
        do {
            let r: UsersResp = try await api.request("GET", "api/admin/users", body: nil as [String: String]?)
            users = r.users
            totals = r.totals
        } catch {
            message = error.localizedDescription
        }
    }

    private func resetPassword(_ u: User) async {
        let alert = NSAlert()
        alert.messageText = "重置 \(u.username) 的密码"
        alert.informativeText = "留空则生成随机密码"
        let input = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 24))
        alert.accessoryView = input
        alert.addButton(withTitle: "重置")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do {
            let body: [String: String?] = ["password": input.stringValue.isEmpty ? nil : input.stringValue,
                                           "force_random": input.stringValue.isEmpty ? "1" : nil]
            let r: ResetPwResp = try await api.request("POST", "api/admin/users/\(u.id)/password",
                                                       body: body.compactMapValues { $0 })
            message = r.ok == true
                ? (r.generated == true ? "已重置，新密码：\(r.password ?? "")（请转达）" : "已重置")
                : (r.error ?? "失败")
        } catch { message = error.localizedDescription }
    }

    private func setStatus(_ u: User, _ disable: Bool) async {
        do {
            _ = try await api.requestOK("POST", "api/admin/users/\(u.id)/status",
                                        body: ["status": disable ? "disabled" : "active"])
            await load()
        } catch { message = error.localizedDescription }
    }

    private func setAdmin(_ u: User, _ on: Bool) async {
        do {
            _ = try await api.requestOK("POST", "api/admin/users/\(u.id)/admin", body: ["is_admin": on])
            await load()
        } catch { message = error.localizedDescription }
    }

    private func rename(_ u: User) async {
        let alert = NSAlert()
        alert.messageText = "修改 \(u.username) 的昵称"
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 24))
        input.stringValue = u.display_name ?? ""
        alert.accessoryView = input
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        _ = try? await api.requestOK("PATCH", "api/admin/users/\(u.id)", body: ["display_name": input.stringValue])
        await load()
    }

    private func delete(_ u: User) async {
        let alert = NSAlert()
        alert.messageText = "删除账号 \(u.username)？"
        alert.informativeText = "会连带删除其会话与学习记忆数据，不可恢复。"
        alert.addButton(withTitle: "删除")
        alert.addButton(withTitle: "取消")
        alert.alertStyle = .warning
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do {
            _ = try await api.requestOK("DELETE", "api/admin/users/\(u.id)", body: nil as [String: String]?)
            await load()
        } catch { message = error.localizedDescription }
    }

    private func purgeGuests() async {
        do {
            let r: PurgeResp = try await api.request("POST", "api/admin/guests/purge", body: Empty())
            message = "已清理 \(r.removed ?? 0) 个到期游客"
            await load()
        } catch { message = error.localizedDescription }
    }
}

// MARK: 新建账号

private struct NewUserSheet: View {
    let onDone: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var username = ""
    @State private var password = ""
    @State private var role = "student"
    @State private var displayName = ""
    @State private var isAdmin = false
    @State private var parentId = ""
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("新建账号").font(.headline)
            TextField("用户名（3-32 位字母数字下划线）", text: $username).textFieldStyle(.roundedBorder)
            SecureField("密码（至少 6 位）", text: $password).textFieldStyle(.roundedBorder)
            Picker("角色", selection: $role) {
                Text("学生").tag("student")
                Text("家长").tag("parent")
            }.pickerStyle(.segmented)
            TextField("昵称（可选）", text: $displayName).textFieldStyle(.roundedBorder)
            if role == "student" {
                TextField("绑定家长 id（可选）", text: $parentId).textFieldStyle(.roundedBorder)
            }
            Toggle("管理员", isOn: $isAdmin)
            if let e = errorText { Text(e).foregroundStyle(.red).font(.footnote) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button("创建") {
                    Task { await create() }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(username.isEmpty || password.count < 6)
            }
        }
        .padding(16)
        .frame(width: 380)
    }

    private func create() async {
        do {
            let body: [String: AnyEncodable] = [
                "username": AnyEncodable(username),
                "password": AnyEncodable(password),
                "role": AnyEncodable(role),
                "display_name": AnyEncodable(displayName),
                "is_admin": AnyEncodable(isAdmin),
                "parent_id": AnyEncodable(parentId.isEmpty ? nil : parentId),
            ]
            let r: CreatedUserResp = try await APIClient.shared.request("POST", "api/admin/users", body: body)
            if r.ok == true {
                onDone("已创建 \(username)")
                dismiss()
            } else {
                errorText = r.error ?? "失败"
            }
        } catch {
            errorText = error.localizedDescription
        }
    }
}

// MARK: 审计日志

private struct AuditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var logs: [AuditRow] = []
    @State private var actionFilter = ""

    var body: some View {
        VStack(spacing: 0) {
            Text("审计日志（近 90 天）").font(.headline).padding(12)
            HStack {
                TextField("按 action 过滤（如 login_success）", text: $actionFilter)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await load() } }
                Button("查询") { Task { await load() } }
            }
            .padding(.horizontal, 12)
            Table(logs) {
                TableColumn("时间") { Text(fmtDate($0.created_at)) }.width(100)
                TableColumn("操作") { Text($0.action ?? "") }.width(130)
                TableColumn("操作者") { Text(actorText($0)) }.width(130)
                TableColumn("对象") { Text(targetText($0)) }.width(140)
                TableColumn("详情") { Text($0.detail ?? "") }
                TableColumn("IP") { Text($0.ip ?? "") }.width(110)
            }
            HStack {
                Spacer()
                Button("关闭") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            .padding(12)
        }
        .frame(width: 860, height: 560)
        .onAppear { Task { await load() } }
    }

    private func actorText(_ l: AuditRow) -> String {
        let name = l.actor_username ?? "—"
        let role = l.actor_role ?? ""
        return role.isEmpty ? name : "\(name)(\(role))"
    }

    private func targetText(_ l: AuditRow) -> String {
        let type = l.target_type ?? ""
        let id = l.target_id ?? ""
        return "\(type) \(id)".trimmingCharacters(in: .whitespaces)
    }

    private func load() async {
        var q: [String: String] = ["limit": "200"]
        if !actionFilter.isEmpty { q["action"] = actionFilter }
        let r: AuditResp? = try? await APIClient.shared.request("GET", "api/admin/audit", query: q, body: nil as [String: String]?)
        logs = r?.logs ?? []
    }
}
