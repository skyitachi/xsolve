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
            // 左侧品牌区：HIG 的登录窗常用「中性底 + 一个品牌标记」，
            // 大面积彩色渐变在 macOS 上显得像网页，这里收掉。
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "pencil.and.ruler.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 38, height: 38)
                        .background(
                            LinearGradient(colors: [Color.brand, Color(hex: 0x7C3AED)],
                                           startPoint: .topLeading, endPoint: .bottomTrailing),
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                        )
                    VStack(alignment: .leading, spacing: 2) {
                        Text("小学AI做题助手").font(.system(size: 14, weight: .semibold))
                        Text("题目 · 手写草稿 · AI 助教")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }

                Spacer(minLength: 24)

                Text("把题拍下来，\n让 AI 陪你想明白。")
                    .font(.system(size: 25, weight: .semibold))
                    .lineSpacing(5)
                    .fixedSize(horizontal: false, vertical: true)
                Text("每一步都留在自己的设备上，家长可以看到完整的学习记录。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.top, 10)
                    .fixedSize(horizontal: false, vertical: true)

                Spacer(minLength: 24)

                Text(APIClient.shared.baseURL)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(36)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(.regularMaterial)

            Divider()

            // 右侧表单
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(mode == .login ? "登录" : "创建账号")
                        .font(.system(size: 19, weight: .semibold))

                    Picker("", selection: $mode) {
                        ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()

                    field("用户名", text: $username, placeholder: "3-32 位字母、数字或下划线")
                    VStack(alignment: .leading, spacing: 4) {
                        Text("密码").font(.caption).foregroundStyle(.secondary)
                        SecureField("至少 6 位", text: $password)
                            .textFieldStyle(.roundedBorder)
                    }

                    if mode == .register {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("确认密码").font(.caption).foregroundStyle(.secondary)
                            SecureField("再输一次", text: $password2)
                                .textFieldStyle(.roundedBorder)
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            Text("注册角色").font(.caption).foregroundStyle(.secondary)
                            Picker("", selection: $role) {
                                Text("学生（需家长邀请码）").tag("student")
                                Text("家长").tag("parent")
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                        }
                        field("昵称（可选）", text: $displayName, placeholder: "显示用的名字")
                        if role == "student" {
                            field("家长邀请码", text: $inviteCode, placeholder: "家长在账户菜单里生成")
                        }
                    }

                    if let e = errorText {
                        Label(e, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Button {
                        Task { await submit() }
                    } label: {
                        if busy {
                            ProgressView().controlSize(.small)
                                .frame(maxWidth: .infinity)
                        } else {
                            Text(mode == .login ? "登录" : "注册并登录")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .controlSize(.large)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || username.isEmpty || password.isEmpty)

                    Button {
                        Task { await guest() }
                    } label: {
                        Label("游客试用（无需注册）", systemImage: "person.crop.circle.badge.questionmark")
                            .frame(maxWidth: .infinity)
                    }
                    .controlSize(.large)
                    .disabled(busy)

                    Divider()

                    Button {
                        showServer.toggle()
                    } label: {
                        Label(showServer ? "隐藏服务器设置" : "服务器设置",
                              systemImage: showServer ? "chevron.up" : "server.rack")
                            .font(.footnote)
                    }
                    .buttonStyle(.borderless)

                    if showServer {
                        VStack(alignment: .leading, spacing: 8) {
                            TextField("服务器地址", text: $serverURL)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 11.5, design: .monospaced))
                            Toggle("允许自签名证书（局域网 HTTPS）", isOn: $allowSelfSigned)
                                .font(.footnote)
                            Button("保存并测试连接") {
                                Task { await testServer() }
                            }
                            .controlSize(.small)
                        }
                        .cardSurface(padding: 12)
                    }
                }
                .padding(32)
            }
            .frame(width: 400)
            .frame(maxHeight: .infinity)
            .background(Color(nsColor: .windowBackgroundColor))
        }
        .frame(minWidth: 880, minHeight: 560)
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
