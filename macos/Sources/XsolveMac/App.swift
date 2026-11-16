import SwiftUI

// MARK: - 全局应用状态

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    let api = APIClient.shared

    @Published var user: User?
    @Published var bootstrapped = false
    /// 家长当前查看的孩子（与 Web 端 localStorage xsolve_view_student 对齐）
    @Published var viewStudentId: String?
    /// 错题本「重做」跳回做题页的深链
    @Published var deepLink: (problemId: String, review: Bool)?
    /// 侧栏选中页面
    @Published var page: Page = .tutor

    enum Page: String, CaseIterable, Identifiable {
        case tutor = "做题"
        case wrongBook = "错题本"
        case memory = "学习档案"
        case myChildren = "我的孩子"
        case eval = "评估面板"
        case prompts = "Prompt 管理"
        case modelSettings = "模型配置"
        case accounts = "账号管理"
        var id: String { rawValue }

        var icon: String {
            switch self {
            case .tutor: return "pencil.and.ruler"
            case .wrongBook: return "book.fill"
            case .memory: return "brain"
            case .myChildren: return "person.2.fill"
            case .eval: return "chart.bar.fill"
            case .prompts: return "doc.text.fill"
            case .modelSettings: return "key.fill"
            case .accounts: return "folder.fill"
            }
        }

        var isAdminOnly: Bool {
            switch self {
            case .eval, .prompts, .modelSettings, .accounts: return true
            default: return false
            }
        }

        var isParentOnly: Bool { self == .myChildren }
    }

    init() {
        viewStudentId = UserDefaults.standard.string(forKey: "xsolve_view_student")
    }

    func bootstrap() async {
        do {
            let u = try await api.me()
            user = u
            if u.role == "parent" { normalizeViewStudent() }
        } catch {
            user = nil
        }
        bootstrapped = true
    }

    func applyLogin(_ u: User) {
        user = u
        if u.role == "parent" { normalizeViewStudent() }
    }

    private func normalizeViewStudent() {
        let kids = user?.children ?? []
        if let cur = viewStudentId, kids.contains(where: { $0.id == cur }) { return }
        viewStudentId = kids.first?.id
    }

    func switchChild(_ id: String) {
        viewStudentId = id
        UserDefaults.standard.set(id, forKey: "xsolve_view_student")
        deepLink = nil
    }

    func doLogout() async {
        await api.logout()
        user = nil
        viewStudentId = nil
        UserDefaults.standard.removeObject(forKey: "xsolve_view_student")
        page = .tutor
    }

    // MARK: 会话 ID 持久化（与 Web 端 localStorage 键语义对齐：按 账号+角色 隔离）

    func savedSessionKey(mode: String) -> String {
        "xsolve_session_\(user?.id ?? "anon")_\(mode)"
    }

    func saveSessionId(_ id: String?, mode: String) {
        let key = savedSessionKey(mode: mode)
        if let id { UserDefaults.standard.set(id, forKey: key) }
        else { UserDefaults.standard.removeObject(forKey: key) }
    }

    func savedSessionId(mode: String) -> String? {
        UserDefaults.standard.string(forKey: savedSessionKey(mode: mode))
    }
}

// MARK: - 入口

@main
struct XsolveApp: App {
    @StateObject private var model = AppModel.shared

    init() {
        // 无界面自检模式：验证接口契约后直接退出
        if SelfTest.shouldRun() { SelfTest.runAndExit() }
        // UI 回归探针：模拟输入/流式重算，检查 WKWebView 是否被反复重建
        if UIProbe.active { UIProbe.autorun() }
        // 真实发送链路探针：登录 + 建会话 + 真 SSE 对话
        if SendProbe.active { SendProbe.autorun() }
        // 富文本取色探针：深色/浅色外观下正文、表格、公式的实际颜色
        if ColorProbe.active { ColorProbe.runAndExit() }
        // 草稿画布探针：合成鼠标事件，验证画笔/橡皮/撤销/导出
        if DrawProbe.active { DrawProbe.runAndExit() }
        // 视觉探针：工具条/画布离屏渲染成 PNG，供人工验收
        if SnapProbe.active { SnapProbe.runAndExit() }
        // 「识别草稿」链路探针：真 exportImage + 真 SSE，导出图落盘供目视
        if RecogProbe.active { RecogProbe.autorun() }
    }

    var body: some Scene {
        WindowGroup("小学AI做题助手") {
            if SendProbe.active {
                ChatPanel(state: SendProbe.state)
                    .environmentObject(model)
                    .frame(width: 560, height: 780)
            } else if RecogProbe.active {
                WorkPanel(state: RecogProbe.state)
                    .environmentObject(model)
                    .frame(width: 760, height: 900)
            } else if UIProbe.active {
                ProbeRoot(m: UIProbe.model)
            } else {
                RootView()
                    .environmentObject(model)
                    .frame(minWidth: 1080, minHeight: 680)
                    .onAppear {
                        if !model.bootstrapped {
                            Task { await model.bootstrap() }
                        }
                    }
            }
        }
        .windowStyle(.automatic)
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            if !model.bootstrapped {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("连接 \(APIClient.shared.baseURL) …").font(.footnote).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.user == nil {
                LoginView()
            } else {
                MainTabView()
            }
        }
    }
}

// MARK: - 主框架（侧栏导航，对应 Web 端顶栏各页面入口）

struct MainTabView: View {
    @EnvironmentObject var model: AppModel
    @State private var showAccount = false

    private var visiblePages: [AppModel.Page] {
        AppModel.Page.allCases.filter { p in
            if p.isAdminOnly { return model.user?.is_admin == true }
            if p.isParentOnly { return model.user?.role == "parent" || model.user?.is_admin == true }
            return true
        }
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $model.page) {
                Section("学习") {
                    ForEach(visiblePages.filter { !$0.isAdminOnly && !$0.isParentOnly }) { p in
                        NavigationLink(value: p) { Label(p.rawValue, systemImage: p.icon) }
                    }
                }
                if !visiblePages.filter(\.isParentOnly).isEmpty {
                    Section("家庭") {
                        ForEach(visiblePages.filter(\.isParentOnly)) { p in
                            NavigationLink(value: p) { Label(p.rawValue, systemImage: p.icon) }
                        }
                    }
                }
                if model.user?.is_admin == true {
                    Section("管理") {
                        ForEach(visiblePages.filter(\.isAdminOnly)) { p in
                            NavigationLink(value: p) { Label(p.rawValue, systemImage: p.icon) }
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 160, ideal: 180)
        } detail: {
            switch model.page {
            case .tutor: TutorView()
            case .wrongBook: WrongBookView()
            case .memory: MemoryView()
            case .myChildren: MyChildrenView()
            case .eval: EvalView()
            case .prompts: PromptsView()
            case .modelSettings: ModelSettingsView()
            case .accounts: AccountsView()
            }
        }
        .navigationTitle(model.page.rawValue)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if model.user?.is_guest == true { GuestBadge() }
                Button {
                    showAccount = true
                } label: {
                    Label(model.user?.label ?? "账户", systemImage: "person.crop.circle")
                }
            }
        }
        .sheet(isPresented: $showAccount) {
            AccountDialog()
                .environmentObject(model)
        }
    }
}

private struct GuestBadge: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        let remaining: String = {
            guard let exp = model.user?.guest_expires_at else { return "" }
            let ms = exp - Date().timeIntervalSince1970
            if ms <= 0 { return "已到期" }
            let h = Int(ms) / 3600
            return h > 0 ? "剩余约 \(h) 小时" : "剩余约 \(Int(ms) / 60) 分钟"
        }()
        Text("🧪 游客试用中\(remaining.isEmpty ? "" : "（\(remaining)）")")
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Color.orange.opacity(0.15))
            .clipShape(Capsule())
    }
}
