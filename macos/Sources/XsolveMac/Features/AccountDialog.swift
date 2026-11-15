import SwiftUI

// MARK: - 账户弹窗（auth.js 账户对话框：改密 / 邀请码 / 绑定码 / 切换孩子 / 页面入口）

struct AccountDialog: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let api = APIClient.shared

    @State private var oldPw = ""
    @State private var newPw = ""
    @State private var pwMsg: String?
    @State private var codeMsg: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("👤 我的账户").font(.headline)

            if let u = model.user {
                Text("\(u.label)（\(u.roleText)\(u.username.isEmpty ? "" : " · \(u.username)")）")
                    .font(.callout)

                if u.is_guest == true {
                    Text("🧪 游客试用中，到期后数据会自动清理 · 注册正式账号可长期保存学习记录")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }

                // 家长：切换查看的孩子 + 邀请码 / 绑定码
                if u.role == "parent" {
                    Divider()
                    VStack(alignment: .leading, spacing: 8) {
                        Text("查看的孩子").font(.caption.bold())
                        let kids = u.children ?? []
                        if kids.isEmpty {
                            Text("（尚未绑定孩子，去「我的孩子」页用绑定码绑定）")
                                .font(.footnote).foregroundStyle(.secondary)
                        } else {
                            Picker("", selection: Binding(
                                get: { model.viewStudentId ?? kids.first?.id },
                                set: { model.switchChild($0 ?? "") })) {
                                ForEach(kids) { k in
                                    Text((k.display_name ?? k.username) + (k.relation.map { "（\($0)）" } ?? ""))
                                        .tag(k.id as String?)
                                }
                            }
                            .pickerStyle(.radioGroup)
                        }
                        HStack {
                            Button("➕ 邀请码（孩子注册用）") { Task { await genInvite() } }
                            Button("🔗 绑定码（给另一位家长）") { Task { await genBindCode() } }
                                .disabled(kids.isEmpty)
                        }
                        if let c = codeMsg { Text(c).font(.caption).textSelection(.enabled).foregroundStyle(.secondary) }
                    }
                }

                // 修改密码（游客隐藏）
                if u.is_guest != true {
                    Divider()
                    DisclosureGroup("🔒 修改密码") {
                        VStack(alignment: .leading, spacing: 6) {
                            SecureField("原密码", text: $oldPw).textFieldStyle(.roundedBorder)
                            SecureField("新密码（至少 6 位）", text: $newPw).textFieldStyle(.roundedBorder)
                            HStack {
                                Button("提交修改") { Task { await changePw() } }
                                    .disabled(oldPw.isEmpty || newPw.count < 6)
                                if let m = pwMsg { Text(m).font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                        .padding(.top, 6)
                    }
                }
            }

            Divider()

            // 页面快捷入口（按角色可见性裁剪，与 Web 端 nav 一致）
            VStack(alignment: .leading, spacing: 6) {
                navLink("🧠 学习档案", .memory)
                if model.user?.role == "parent" {
                    navLink("👨‍👩‍👧 我的孩子", .myChildren)
                }
                if model.user?.is_admin == true {
                    navLink("📊 评估面板", .eval)
                    navLink("📝 Prompt 管理", .prompts)
                    navLink("🔑 模型配置", .modelSettings)
                    navLink("🗂 账号管理", .accounts)
                }
            }

            Spacer()

            HStack {
                Button("退出登录", role: .destructive) {
                    Task {
                        await model.doLogout()
                        dismiss()
                    }
                }
                Spacer()
                Button("关闭") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(18)
        .frame(width: 400, height: 520)
    }

    private func navLink(_ label: String, _ page: AppModel.Page) -> some View {
        Button {
            model.page = page
            dismiss()
        } label: {
            Text(label).frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.brand)
    }

    private func genInvite() async {
        do {
            let r: InviteResp = try await api.request("POST", "api/auth/invite", body: Empty())
            codeMsg = "邀请码：\(r.code)（7 天内有效，让孩子注册时填写）"
        } catch {
            codeMsg = "失败：\(error.localizedDescription)"
        }
    }

    private func genBindCode() async {
        do {
            let r: InviteResp = try await api.request("POST", "api/family/bind-codes",
                                                      body: ["studentId": model.viewStudentId as String?])
            codeMsg = "绑定码：\(r.code)（7 天内有效，让另一位家长在「我的孩子」页填码绑定）"
        } catch {
            codeMsg = "失败：\(error.localizedDescription)"
        }
    }

    private func changePw() async {
        do {
            let note = try await api.changePassword(old: oldPw, new: newPw)
            pwMsg = "✅ \(note)"
            oldPw = ""; newPw = ""
        } catch {
            pwMsg = "❌ \(error.localizedDescription)"
        }
    }
}
