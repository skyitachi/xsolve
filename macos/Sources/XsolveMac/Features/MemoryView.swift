import SwiftUI

// MARK: - 学习档案（student-memory.html）

struct MemoryView: View {
    @EnvironmentObject var model: AppModel
    let api = APIClient.shared

    @State private var overview: MemoryOverview?
    @State private var days = 30
    @State private var errorText: String?
    @State private var consolidating = false
    @State private var consolidateMsg: String?
    @State private var adminStudentId: String = ""

    private var studentParam: String? {
        if model.user?.role == "parent" { return model.viewStudentId }
        if model.user?.is_admin == true { return adminStudentId.isEmpty ? nil : adminStudentId }
        return nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("🧠 学习档案").font(.title2.bold())
                    Spacer()
                    Picker("范围", selection: $days) {
                        Text("30 天").tag(30)
                        Text("90 天").tag(90)
                        Text("180 天").tag(180)
                    }
                    .frame(width: 160)
                    if model.user?.role == "parent", let kids = model.user?.children, kids.count > 1 {
                        Picker("孩子", selection: Binding(get: { model.viewStudentId }, set: { model.switchChild($0 ?? "") })) {
                            ForEach(kids) { k in
                                Text(k.display_name ?? k.username).tag(k.id as String?)
                            }
                        }
                        .frame(width: 140)
                    }
                    if model.user?.is_admin == true {
                        TextField("studentId（管理员必填）", text: $adminStudentId)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 200)
                            .font(.system(size: 11, design: .monospaced))
                    }
                    Button {
                        Task { await consolidate() }
                    } label: {
                        if consolidating { ProgressView().controlSize(.small) }
                        else { Label("刷新画像", systemImage: "wand.and.stars") }
                    }
                    .disabled(consolidating)
                }

                if let e = errorText { Text(e).foregroundStyle(.red) }
                if let m = consolidateMsg { Text(m).foregroundStyle(.secondary).font(.footnote) }

                if let o = overview {
                    // 概览统计卡
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 10) {
                        StatCard(title: "累计作答", value: "\(o.stats.total)", color: .brand)
                        StatCard(title: "答对", value: "\(o.stats.correct)", color: .green)
                        StatCard(title: "正确率", value: "\(o.stats.rate)%", color: o.stats.rate >= 70 ? .green : .orange)
                        StatCard(title: "最近作答", value: fmtDate(o.stats.last_at), color: .secondary)
                    }

                    // 画像
                    if let p = o.profile {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("AI 画像").font(.headline)
                            HStack(spacing: 12) {
                                if let lv = p.level { Tag("水平：\(lv)") }
                                if let ind = p.independence { Tag("独立性：\(ind)") }
                                Text("更新于 \(fmtDate(p.updated_at))").font(.caption2).foregroundStyle(.secondary)
                            }
                            if let n = p.narrative, !n.isEmpty {
                                Text(n).font(.callout).padding(10)
                                    .background(Color.brand.opacity(0.06)).cornerRadius(8)
                            }
                        }
                        .padding(14)
                        .background(Color.gray.opacity(0.05)).cornerRadius(12)
                    }

                    // 每日正确率
                    if !o.daily.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("每日正确率（\(days) 天）").font(.headline)
                            DailyAccuracyChart(rows: o.daily)
                        }
                        .padding(14)
                        .background(Color.gray.opacity(0.05)).cornerRadius(12)
                    }

                    HSplitView {
                        masteryPane(o)
                        scratchPane(o)
                    }
                    .frame(height: 320)

                    HSplitView {
                        attemptsPane(o)
                        factsPane(o)
                    }
                    .frame(height: 300)
                } else if errorText == nil {
                    ProgressView("加载中…").frame(maxWidth: .infinity).padding(40)
                }
            }
            .padding(18)
        }
        .onAppear { Task { await load() } }
        .onChange(of: days) { _ in Task { await load() } }
        .onChange(of: adminStudentId) { _ in Task { await load() } }
        .onChange(of: model.viewStudentId) { _ in Task { await load() } }
    }

    /// 主题掌握度面板（拆出来只为避免 body 表达式过大导致类型推断超时）
    @ViewBuilder
    private func masteryPane(_ o: MemoryOverview) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("主题掌握度").font(.headline)
            if o.mastery.isEmpty {
                Text("暂无数据").foregroundStyle(.secondary)
            }
            ForEach(o.mastery) { m in
                masteryRow(m)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    @ViewBuilder
    private func masteryRow(_ m: MasteryRow) -> some View {
        let pct = Int(m.mastery)
        let width = CGFloat(m.mastery) / 100
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(m.topic).font(.callout)
                Spacer()
                Text("\(m.correct)/\(m.attempts) · \(pct)%")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.gray.opacity(0.15))
                    Capsule().fill(masteryColor(pct))
                        .frame(width: geo.size.width * width)
                }
            }
            .frame(height: 8)
        }
    }

    @ViewBuilder
    private func scratchPane(_ o: MemoryOverview) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("✏️ 动笔演算习惯").font(.headline)
            if let s = o.scratch {
                Tag("动笔轮次占比 \(Int(((s.scratch_turn_ratio ?? 0) * 100).rounded()))%")
                Tag("动笔作答 \(s.attempts_with_scratch ?? 0) 次 / 不动笔 \(s.attempts_without_scratch ?? 0) 次")
                if let w = s.accuracy_with_scratch, let wo = s.accuracy_without_scratch {
                    Tag("动笔正确率 \(Int(w * 100))% vs 不动笔 \(Int(wo * 100))%")
                }
            } else {
                Text("暂无数据").foregroundStyle(.secondary)
            }
            if let ed = o.error_distribution, !ed.isEmpty {
                Divider()
                Text("错因分布").font(.headline)
                ForEach(ed, id: \.topic) { e in
                    HStack {
                        Text(e.topic).font(.callout)
                        Spacer()
                        Text("×\(e.n)").foregroundStyle(.red)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    @ViewBuilder
    private func attemptsPane(_ o: MemoryOverview) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("最近作答").font(.headline)
            Table(o.attempts) {
                TableColumn("时间") { Text(fmtDate($0.created_at)) }.width(90)
                TableColumn("主题") { Text($0.topic ?? "—") }.width(100)
                TableColumn("答案") { Text($0.user_answer ?? "") }
                TableColumn("对错") { Text($0.correct ? "✅" : "❌") }.width(36)
                TableColumn("错因") { Text($0.error_type ?? "") }.width(60)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func factsPane(_ o: MemoryOverview) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("AI 记住的观察").font(.headline)
            if o.facts.isEmpty { Text("暂无").foregroundStyle(.secondary) }
            ForEach(o.facts) { f in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(f.kind ?? "").font(.caption2.bold()).foregroundStyle(Color.brand)
                        Spacer()
                        Text(fmtDate(f.created_at)).font(.caption2).foregroundStyle(.secondary)
                    }
                    Text(f.content ?? "").font(.callout)
                }
                .padding(8)
                .background(Color.gray.opacity(0.05)).cornerRadius(8)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func masteryColor(_ v: Int) -> Color {
        v >= 80 ? .green : (v >= 50 ? .orange : .red)
    }

    private func load() async {
        errorText = nil
        var q: [String: String] = ["days": String(days)]
        if let s = studentParam { q["studentId"] = s }
        do {
            overview = try await api.request("GET", "api/memory/overview", query: q, body: nil as [String: String]?)
        } catch {
            self.errorText = error.localizedDescription
        }
    }

    private func consolidate() async {
        consolidating = true
        defer { consolidating = false }
        var q: [String: String] = [:]
        if let s = studentParam { q["studentId"] = s }
        do {
            let r = try await api.requestOK("POST", "api/memory/consolidate", query: q.isEmpty ? nil : q, body: Empty())
            consolidateMsg = r["message"]?.stringValue ?? r["facts_added"].map { "新增 \($0) 条观察" }?.description ?? "已刷新"
            await load()
        } catch {
            consolidateMsg = "失败：\(error.localizedDescription)"
        }
    }
}

// MARK: - 小组件

struct Tag: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.caption)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Color.brand.opacity(0.1))
            .clipShape(Capsule())
    }
}

struct StatCard: View {
    let title: String
    let value: String
    let color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.bold()).foregroundColor(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.gray.opacity(0.05))
        .cornerRadius(10)
    }
}

struct DailyAccuracyChart: View {
    let rows: [DailyAccuracyRow]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .bottom, spacing: 3) {
                ForEach(rows) { r in
                    VStack(spacing: 2) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(r.rate >= 70 ? Color.green : (r.rate >= 40 ? Color.orange : Color.red))
                            .frame(height: max(4, CGFloat(r.rate)))
                        Text(String(r.day.suffix(5)))
                            .font(.system(size: 7))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(-45))
                    }
                    .frame(maxHeight: 100, alignment: .bottom)
                    .help("\(r.day)：\(r.correct)/\(r.total)（\(r.rate)%）")
                }
            }
            .frame(height: 120)
        }
    }
}
