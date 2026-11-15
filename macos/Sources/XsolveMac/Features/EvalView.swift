import SwiftUI

// MARK: - 评估面板（eval.html + student-eval.html 合并，管理员）

struct EvalView: View {
    @State private var tab: Tab = .dashboard
    @State private var role = "student"

    enum Tab: String, CaseIterable { case dashboard = "总览", turns = "Turns", sessions = "会话评估", students = "学生评估" }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Picker("角色", selection: $role) {
                    Text("学生").tag("student")
                    Text("家长").tag("parent")
                }
                .pickerStyle(.segmented)
                .frame(width: 200)
                Spacer()
                Picker("", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 360)
            }
            .padding(12)

            Divider()

            switch tab {
            case .dashboard: EvalDashboardTab(role: role)
            case .turns: EvalTurnsTab(role: role)
            case .sessions: EvalSessionsTab(role: role)
            case .students: EvalStudentsTab(role: role)
            }
        }
    }
}

// MARK: 总览

private struct EvalDashboardTab: View {
    let role: String
    let api = APIClient.shared
    @State private var data: EvalDashboard?

    var body: some View {
        ScrollView {
            if let d = data {
                VStack(alignment: .leading, spacing: 14) {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 10) {
                        StatCard(title: "Turn 总数", value: "\(d.total_turns ?? 0)", color: .brand)
                        StatCard(title: "已评估", value: "\(d.evaluated_turns ?? 0)", color: .purple)
                        StatCard(title: "输入 Token", value: fmtToken(d.token_stats?.total_input_tokens), color: .secondary)
                        StatCard(title: "输出 Token", value: fmtToken(d.token_stats?.total_output_tokens), color: .secondary)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("LLM Judge 维度均分").font(.headline)
                        if let scores = d.llm_scores, !scores.isEmpty {
                            ForEach(scores) { s in
                                HStack {
                                    Text(s.dimension).frame(width: 160, alignment: .leading)
                                    GeometryReader { geo in
                                        ZStack(alignment: .leading) {
                                            Capsule().fill(Color.gray.opacity(0.15))
                                            Capsule().fill(Color.brand)
                                                .frame(width: geo.size.width * CGFloat(min((s.avg_value ?? 0) / 5, 1)))
                                        }
                                    }.frame(height: 10)
                                    Text(String(format: "%.2f（%d 条）", s.avg_value ?? 0, s.count ?? 0))
                                        .font(.caption.monospacedDigit())
                                        .frame(width: 110, alignment: .trailing)
                                }
                            }
                        } else { Text("暂无评分").foregroundStyle(.secondary) }
                    }
                    .padding(14).background(Color.gray.opacity(0.05)).cornerRadius(12)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("最近 Turns").font(.headline)
                        Table(Array((d.recent_turns ?? []).prefix(50))) {
                            TableColumn("时间") { Text(fmtDate($0.created_at)) }.width(100)
                            TableColumn("用户") { Text(($0.user_message ?? "").prefix(60)).lineLimit(1) }
                            TableColumn("AI") { Text(($0.ai_message ?? "").prefix(60)).lineLimit(1) }
                            TableColumn("耗时") { Text(fmtDuration($0.duration_ms)) }.width(70)
                            TableColumn("评分") { Text(($0.llm_scores ?? "").prefix(50)).lineLimit(1) }.width(180)
                        }
                    }
                }
                .padding(16)
            } else {
                ProgressView("加载中…").padding(60)
            }
        }
        .task(id: role) {
            data = try? await api.request("GET", "api/eval/dashboard", query: ["role": role], body: nil as [String: String]?)
        }
    }
}

private func fmtToken(_ v: Int?) -> String {
    guard let v else { return "—" }
    if v > 1_000_000 { return String(format: "%.1fM", Double(v) / 1_000_000) }
    if v > 1000 { return String(format: "%.1fk", Double(v) / 1000) }
    return "\(v)"
}

// MARK: Turns

private struct EvalTurnsTab: View {
    let role: String
    let api = APIClient.shared
    @State private var page = 1
    @State private var data: EvalTurnsPage?
    @State private var selectedTurn: EvalTurnsPage.Turn?
    @State private var judgeMsg: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                if let d = data {
                    Text("共 \(d.total) 条 · 第 \(page) 页")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let m = judgeMsg { Text(m).font(.caption).foregroundStyle(.secondary) }
                Button("上一页") { if page > 1 { page -= 1 } }.disabled(page <= 1)
                Button("下一页") { page += 1 }.disabled((data?.turns.isEmpty ?? true) && page > 1)
            }
            .padding(10)

            Table(turnRows) {
                TableColumn("ID") { Text("#\($0.id)") }.width(60)
                TableColumn("时间") { Text(fmtDate($0.created_at)) }.width(100)
                TableColumn("用户消息") { Text(($0.user_message ?? "").prefix(50)).lineLimit(1) }
                TableColumn("AI 回复") { Text(($0.ai_message ?? "").prefix(50)).lineLimit(1) }
                TableColumn("Tokens") { Text("\($0.input_tokens ?? 0)/\($0.output_tokens ?? 0)") }.width(90)
                TableColumn("评分") { Text(($0.llm_scores ?? "").prefix(40)).lineLimit(1) }.width(160)
                TableColumn("错误") { Text($0.error ?? "") }.width(90)
                TableColumn("") { t in
                    Button("▶︎ 评估") {
                        Task {
                            do {
                                let r = try await api.requestOK("POST", "api/eval/judge/\(t.id)", body: ["session_id": t.session_id ?? ""])
                                judgeMsg = r["ok"]?.boolValue == true ? "已触发评估 turn #\(t.id)" : "触发失败"
                            } catch { judgeMsg = "失败：\(error.localizedDescription)" }
                        }
                    }
                    .controlSize(.small)
                }.width(70)
            }
            .overlay { if data == nil { ProgressView() } }
        }
        .task(id: "\(role)-\(page)") {
            await loadPage()
        }
    }
    private var turnRows: [EvalTurnsPage.Turn] { data?.turns ?? [] }

    private func loadPage() async {
        data = try? await api.request("GET", "api/eval/turns",
                                      query: ["role": role, "page": String(page)],
                                      body: nil as [String: String]?)
    }
}

// MARK: 会话评估

private struct EvalSessionsTab: View {
    let role: String
    let api = APIClient.shared
    @State private var rows: [SessionEvalRow] = []
    @State private var message: String?

    var body: some View {
        VStack(spacing: 0) {
            if let m = message {
                Text(m).font(.caption).foregroundStyle(.secondary).padding(8)
            }
            Table(rows) {
                TableColumn("会话") { Text(($0.title ?? $0.id).prefix(40)) }
                TableColumn("学生") { Text($0.display_name ?? $0.username ?? "—") }.width(110)
                TableColumn("Turns") { Text("\($0.turn_count ?? 0)") }.width(60)
                TableColumn("评估均分") {
                    if let s = $0.avg_score { Text(String(format: "%.2f", s)) }
                    else { Text("未评估").foregroundStyle(.secondary) }
                }.width(80)
                TableColumn("更新") { Text(fmtDate($0.updated_at)) }.width(110)
                TableColumn("") { row in
                    Button("触发评估") {
                        Task {
                            do {
                                _ = try await api.requestOK("POST", "api/eval/session/\(row.id)/judge", body: Empty())
                                message = "已触发会话评估（后台执行，稍后刷新查看）"
                            } catch { message = "失败：\(error.localizedDescription)" }
                        }
                    }
                    .controlSize(.small)
                }.width(90)
            }
        }
        .task(id: role) {
            rows = (try? await api.request("GET", "api/eval/sessions", query: ["role": role], body: nil as [String: String]?)) ?? []
        }
    }
}

// MARK: 学生评估

private struct EvalStudentsTab: View {
    let role: String
    let api = APIClient.shared
    @State private var rows: [SessionEvalRow] = []
    @State private var message: String?

    var body: some View {
        VStack(spacing: 0) {
            if let m = message {
                Text(m).font(.caption).foregroundStyle(.secondary).padding(8)
            }
            Table(rows) {
                TableColumn("会话") { Text(($0.title ?? $0.id).prefix(36)) }
                TableColumn("学生") { Text($0.display_name ?? $0.username ?? "—") }.width(110)
                TableColumn("Turns") { Text("\($0.turn_count ?? 0)") }.width(60)
                TableColumn("均分") {
                    if let s = $0.avg_score { Text(String(format: "%.2f", s)) }
                    else { Text("未评估").foregroundStyle(.secondary) }
                }.width(80)
                TableColumn("更新") { Text(fmtDate($0.updated_at)) }.width(110)
                TableColumn("") { row in
                    Button("触发评估") {
                        Task {
                            do {
                                _ = try await api.requestOK("POST", "api/eval/student/judge/\(row.id)", body: Empty())
                                message = "已触发学生评估（后台执行）"
                            } catch { message = "失败：\(error.localizedDescription)" }
                        }
                    }
                    .controlSize(.small)
                }.width(90)
            }
        }
        .task(id: role) {
            rows = (try? await api.request("GET", "api/eval/student/sessions", query: ["role": role], body: nil as [String: String]?)) ?? []
        }
    }
}
