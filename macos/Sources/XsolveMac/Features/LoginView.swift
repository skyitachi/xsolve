import SwiftUI

// MARK: - 登录页（login.html 对应）
// 登录 / 注册（学生须邀请码）/ 游客试用；服务器地址与自签证书开关也在这里配。

struct LoginView: View {
    @EnvironmentObject var model: AppModel
    @State private var mode: Mode = .login
    @State private var username = ""
    @State private var password = ""
    @State private var password2 = ""
    @State private var role = "student"
    @State private var displayName = ""
    @State private var inviteCode = ""
    @State private var busy = false
    @State private var errorText: String?

    @State private var showServer = false
    @State private var serverURL = APIClient.shared.baseURL
    @State private var allowSelfSigned = APIClient.shared.allowSelfSigned

    enum Mode: String, CaseIterable { case login = "登录", register = "注册" }

    var body: some View {
        HStack(spacing: 0) {
            // 左侧品牌区
            VStack(spacing: 14) {
                Image(systemName: "pencil.and.ruler.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.white)
                Text("小学AI做题助手")
                    .font(.title.bold())
                    .foregroundStyle(.white)
                Text("题目 · 手写草稿 · AI 助教 三合一")
                    .foregroundStyle(.white.opacity(0.85))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(
                LinearGradient(colors: [Color(hex: 0x6366F1), Color(hex: 0x8B5CF6)],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
            )

            // 右侧表单
            VStack(alignment: .leading, spacing: 14) {
                Picker("", selection: $mode) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                field("用户名", text: $username, placeholder: "3-32 位字母、数字或下划线")
                SecureField("密码（至少 6 位）", text: $password)
                    .textFieldStyle(.roundedBorder)

                if mode == .register {
                    SecureField("确认密码", text: $password2)
                        .textFieldStyle(.roundedBorder)
                    Picker("注册角色", selection: $role) {
                        Text("学生（需家长邀请码）").tag("student")
                        Text("家长").tag("parent")
                    }
                    .pickerStyle(.segmented)
                    field("昵称（可选）", text: $displayName, placeholder: "显示用的名字")
                    if role == "student" {
                        field("家长邀请码", text: $inviteCode, placeholder: "家长在账户菜单里生成")
                    }
                }

                if let e = errorText {
                    Text(e).font(.footnote).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                }

                Button {
                    Task { await submit() }
                } label: {
                    if busy { ProgressView().controlSize(.small) }
                    else { Text(mode == .login ? "登录" : "注册并登录").frame(maxWidth: .infinity) }
                }
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
                .disabled(busy || username.isEmpty || password.isEmpty)

                Divider()

                Button {
                    Task { await guest() }
                } label: {
                    Text("🧪 游客试用（无需注册）").frame(maxWidth: .infinity)
                }
                .disabled(busy)

                Button {
                    showServer.toggle()
                } label: {
                    Label("服务器设置", systemImage: "server.rack")
                        .font(.footnote)
                }
                .buttonStyle(.link)

                if showServer {
                    VStack(alignment: .leading, spacing: 6) {
                        TextField("服务器地址", text: $serverURL)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(size: 12, design: .monospaced))
                        Toggle("允许自签名证书（局域网 HTTPS）", isOn: $allowSelfSigned)
                            .font(.footnote)
                        Button("保存并测试连接") {
                            Task { await testServer() }
                        }
                        .controlSize(.small)
                    }
                    .padding(10)
                    .background(Color.gray.opacity(0.08))
                    .cornerRadius(8)
                }
            }
            .padding(36)
            .frame(width: 380)
            .frame(maxHeight: .infinity)
        }
        .onAppear {
            serverURL = APIClient.shared.baseURL
            allowSelfSigned = APIClient.shared.allowSelfSigned
        }
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
        }
    }

    private func submit() async {
        errorText = nil
        guard !busy else { return }
        if mode == .register && password != password2 {
            errorText = "两次输入的密码不一致"
            return
        }
        busy = true
        defer { busy = false }
        do {
            let u: User
            if mode == .login {
                u = try await model.api.login(username: username, password: password)
            } else {
                u = try await model.api.register(
                    username: username, password: password, role: role,
                    displayName: displayName.isEmpty ? nil : displayName,
                    inviteCode: inviteCode.isEmpty ? nil : inviteCode)
            }
            model.applyLogin(u)
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func guest() async {
        errorText = nil
        busy = true
        defer { busy = false }
        do {
            let u = try await model.api.guestLogin()
            model.applyLogin(u)
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func testServer() async {
        APIClient.shared.baseURL = serverURL.trimmingCharacters(in: .whitespaces)
        APIClient.shared.allowSelfSigned = allowSelfSigned
        do {
            if try await model.api.health() {
                errorText = nil
                model.objectWillChange.send()
            } else {
                errorText = "服务返回异常"
            }
        } catch {
            errorText = "连不上：\(error.localizedDescription)"
        }
    }
}
