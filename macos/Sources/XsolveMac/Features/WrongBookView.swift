import SwiftUI

// MARK: - 错题本（wrong-book.html 全功能：本子 CRUD / 筛选 / 详情 / 复习推进 / 拍照录入 / 选题加入）

struct WrongBookView: View {
    @EnvironmentObject var model: AppModel
    let api = APIClient.shared

    @State private var books: [WrongBook] = []
    @State private var stats: WrongBookStats?
    @State private var items: [WrongItem] = []
    @State private var dueTotal: Int?
    @State private var errorTypes: [String] = []
    @State private var selectedBook: String?
    @State private var selectedItem: WrongItem?
    @State private var detail: ItemDetailResp?
    @State private var status = ""           // "" 全部 / due / pending / mastered
    @State private var errorFilter = ""      // "" 全部 / none 未归因 / 枚举
    @State private var sort = ""
    @State private var showAll = false
    @State private var message: String?
    @State private var newBookName = ""
    @State private var showCreateBook = false
    @State private var photoFlow: PhotoFlowState?
    @State private var showCandidates = false

    // 目标学生：学生=自己；家长=当前查看的孩子；管理员=须指定
    private var studentParam: String? {
        if model.user?.role == "parent" { return model.viewStudentId }
        if model.user?.is_admin == true { return adminStudentId }
        return nil
    }
    @State private var adminStudentId: String = ""

    private var query: [String: String] {
        var q: [String: String] = [:]
        if let b = selectedBook { q["bookId"] = b }
        if !status.isEmpty { q["status"] = status }
        if !errorFilter.isEmpty { q["errorType"] = errorFilter }
        if !sort.isEmpty { q["sort"] = sort }
        if showAll { q["all"] = "1" }
        if let s = studentParam { q["studentId"] = s }
        return q
    }

    var body: some View {
        HSplitView {
            // 本子侧栏
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("我的错题本").font(.headline)
                    Spacer()
                    Button { showCreateBook = true } label: { Image(systemName: "plus") }
                        .help("新建错题本")
                }
                .padding(12)

                if model.user?.is_admin == true {
                    HStack {
                        Text("studentId").font(.caption).foregroundStyle(.secondary)
                        TextField("必填", text: $adminStudentId)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(size: 11, design: .monospaced))
                    }
                    .padding(.horizontal, 12)
                }

                List(selection: $selectedBook) {
                    Button {
                        selectedBook = nil
                    } label: {
                        HStack {
                            Image(systemName: "books.vertical")
                            Text("全部").bold()
                            Spacer()
                            Text("\(stats?.total ?? 0)").foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                    ForEach(books) { b in
                        BookRow(book: b, onDelete: { await deleteBook(b) }, onRename: { await renameBook(b) })
                            .tag(b.id)
                            .padding(.vertical, 1)
                    }
                }
                .listStyle(.plain)

                Divider()
                statsSummary
                    .padding(12)
            }
            .frame(width: 240)

            // 条目列表
            VStack(spacing: 0) {
                // 筛选行
                HStack(spacing: 8) {
                    Picker("状态", selection: $status) {
                        Text("全部").tag("")
                        Text("今日待复习").tag("due")
                        Text("待复习").tag("pending")
                        Text("已掌握").tag("mastered")
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 300)

                    Picker("错因", selection: $errorFilter) {
                        Text("全部错因").tag("")
                        Text("未归因").tag("none")
                        ForEach(errorTypes, id: \.self) { Text($0).tag($0) }
                    }
                    .frame(width: 130)

                    Picker("排序", selection: $sort) {
                        Text("默认").tag("")
                        Text("错最多").tag("wrong")
                        Text("最久未练").tag("stale")
                    }
                    .frame(width: 110)

                    if status == "due" {
                        Toggle("看全部到期", isOn: $showAll)
                    }

                    Spacer()

                    Button { showCandidates = true } label: { Label("从题库加入", systemImage: "plus.square.dashed") }
                    Button { startPhotoFlow() } label: { Label("📷 拍照录入", systemImage: "camera") }
                        .buttonStyle(.borderedProminent)
                }
                .padding(10)

                if let m = message {
                    Text(m).font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 12)
                }
                if let d = dueTotal, status == "due", d > items.count {
                    Text("今天还有 \(d) 道到期错题，先消化这批再来吧 💪")
                        .font(.footnote).foregroundStyle(.orange)
                        .padding(.horizontal, 12)
                }

                Divider()

                List(selection: Binding(
                    get: { selectedItem?.id },
                    set: { v in
                        selectedItem = items.first { $0.id == v }
                        Task { await loadDetail() }
                    })) {
                    ForEach(items) { item in
                        WrongItemRow(item: item)
                            .tag(item.id)
                    }
                }
                .listStyle(.plain)
                .overlay {
                    if items.isEmpty {
                        Text(status == "due" ? "今天没有到期的错题 🎉" : "暂无错题")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .frame(minWidth: 340)

            // 详情
            Group {
                if let d = detail {
                    WrongItemDetail(detail: d, errorTypes: errorTypes,
                                    onRedo: { redo(d) },
                                    onReview: { ok in await review(d, correct: ok) },
                                    onMaster: { await master(d, mastered: $0) },
                                    onMeta: { et, note in await setMeta(d, errorType: et, note: note) },
                                    onRemove: { await remove(d) })
                } else {
                    Text("选择左侧错题查看详情")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minWidth: 380)
        }
        .sheet(isPresented: $showCreateBook) {
            VStack(alignment: .leading, spacing: 10) {
                Text("新建错题本").font(.headline)
                TextField("名称（最多 30 字）", text: $newBookName)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Spacer()
                    Button("取消") { showCreateBook = false }
                    Button("创建") {
                        Task { await createBook() }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(newBookName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .padding(16)
            .frame(width: 340)
        }
        .sheet(isPresented: $showCandidates) {
            CandidatesPicker(studentParam: studentParam, bookId: selectedBook) {
                Task { await loadAll() }
            }
        }
        .sheet(item: $photoFlow) { flow in
            PhotoFlowDialog(flow: flow, books: books, studentParam: studentParam) { result in
                message = result
                Task { await loadAll() }
            }
        }
        .onAppear { Task { await loadAll() } }
        .onChange(of: selectedBook) { _ in Task { await loadItems() } }
        .onChange(of: status) { _ in Task { await loadItems() } }
        .onChange(of: errorFilter) { _ in Task { await loadItems() } }
        .onChange(of: sort) { _ in Task { await loadItems() } }
        .onChange(of: showAll) { _ in Task { await loadItems() } }
        .onChange(of: adminStudentId) { _ in Task { await loadAll() } }
    }

    // MARK: 数据

    private var statsSummary: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let s = stats {
                statLine("待复习", "\(s.pending ?? 0)", .orange)
                statLine("今日到期", "\(s.due ?? 0)", .red)
                statLine("已掌握", "\(s.mastered ?? 0)", .green)
                if let next = s.next_due_at, (s.due ?? 0) == 0 {
                    Text("下次复习：\(fmtDate(next))").font(.caption).foregroundStyle(.secondary)
                }
                if let byErr = s.by_error, !byErr.isEmpty {
                    Text("错因：" + byErr.sorted { $0.value > $1.value }
                        .map { "\($0.key)×\($0.value)" }.joined(separator: " "))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func statLine(_ k: String, _ v: String, _ c: Color) -> some View {
        HStack {
            Text(k).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(v).font(.callout.bold()).foregroundColor(c)
        }
    }

    func loadAll() async {
        await loadBooks()
        await loadItems()
    }

    func loadBooks() async {
        var q: [String: String] = [:]
        if let s = studentParam { q["studentId"] = s }
        guard let r: BooksResp = try? await api.request("GET", "api/wrong-book/books", query: q, body: nil as [String: String]?) else { return }
        books = r.books
        stats = r.stats
    }

    func loadItems() async {
        guard let r: ItemsResp = try? await api.request("GET", "api/wrong-book/items", query: query, body: nil as [String: String]?) else { return }
        items = r.items
        dueTotal = r.due_total
        errorTypes = r.error_types ?? []
    }

    func loadDetail() async {
        guard let item = selectedItem else { detail = nil; return }
        var q: [String: String] = [:]
        if let s = studentParam { q["studentId"] = s }
        detail = try? await api.request("GET", "api/wrong-book/items/\(item.id)", query: q, body: nil as [String: String]?)
    }

    // MARK: 操作

    func createBook() async {
        defer { showCreateBook = false }
        _ = try? await api.requestOK("POST", "api/wrong-book/books", query: studentParam.map { ["studentId": $0] } ?? [:], body: ["name": newBookName])
        newBookName = ""
        await loadAll()
    }

    func renameBook(_ b: WrongBook) async {
        let alert = NSAlert()
        alert.messageText = "重命名错题本"
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        input.stringValue = b.name
        alert.accessoryView = input
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        _ = try? await api.requestOK("PATCH", "api/wrong-book/books/\(b.id)", body: ["name": input.stringValue])
        await loadAll()
    }

    func deleteBook(_ b: WrongBook) async {
        let r = try? await api.requestOK("DELETE", "api/wrong-book/books/\(b.id)", body: nil as [String: String]?)
        if case .object(let o)? = r?["error"] { _ = o } // requestOK throws on error
        if let moved = r?["moved"]?.intValue {
            message = "已删除本子，\(moved) 道题移回默认本"
        }
        if selectedBook == b.id { selectedBook = nil }
        await loadAll()
    }

    func redo(_ d: ItemDetailResp) {
        // 深链重做：切到做题页 + 置复习标记（服务端按 problem_id 反查条目）
        model.deepLink = (d.item.problem_id, true)
        model.page = .tutor
    }

    func review(_ d: ItemDetailResp, correct: Bool) async {
        var q: [String: String] = [:]
        if let s = studentParam { q["studentId"] = s }
        let r: ReviewResp? = try? await api.request("POST", "api/wrong-book/items/\(d.item.id)/review", query: q, body: ["correct": correct])
        if let r {
            message = r.graduated == true ? "🎉 恭喜！连续答对且等级封顶，这道题已毕业" : (correct ? "已记录：答对，等级 +1" : "已记录：答错，明天再来")
        }
        await loadAll()
        await loadDetail()
    }

    func master(_ d: ItemDetailResp, mastered: Bool) async {
        var q: [String: String] = [:]
        if let s = studentParam { q["studentId"] = s }
        _ = try? await api.requestOK("POST", "api/wrong-book/items/\(d.item.id)/master", query: q, body: ["mastered": mastered])
        await loadAll()
        await loadDetail()
    }

    func setMeta(_ d: ItemDetailResp, errorType: String?, note: String?) async {
        var q: [String: String] = [:]
        if let s = studentParam { q["studentId"] = s }
        _ = try? await api.requestOK("POST", "api/wrong-book/items/\(d.item.id)/meta", query: q, body: [
            "error_type": errorType as String?, "note": note as String?,
        ])
        await loadDetail()
        await loadItems()
    }

    func remove(_ d: ItemDetailResp) async {
        var q: [String: String] = [:]
        if let s = studentParam { q["studentId"] = s }
        _ = try? await api.requestOK("DELETE", "api/wrong-book/items/\(d.item.id)", query: q, body: nil as [String: String]?)
        selectedItem = nil
        detail = nil
        await loadAll()
    }

    func startPhotoFlow() {
        pickImage { url in
            guard let img = NSImage(contentsOf: url),
                  let d = ImageUtil.jpegDataURL(from: img, maxEdge: 1600) else { return }
            photoFlow = PhotoFlowState(imageDataURL: d)
        }
    }
}

// MARK: - 拍照录入流状态

struct PhotoFlowState: Identifiable {
    let id = UUID()
    let imageDataURL: String
}

// MARK: - 本子行

private struct BookRow: View {
    let book: WrongBook
    let onDelete: () async -> Void
    let onRename: () async -> Void

    var body: some View {
        HStack(spacing: 6) {
            Text(book.emoji ?? "📗")
            Text(book.name)
            if book.is_default {
                Text("默认").font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Text("\(book.total ?? 0)").foregroundStyle(.secondary).font(.caption)
        }
        .contextMenu {
            Button("重命名") { Task { await onRename() } }
            if !book.is_default {
                Button("删除本子（题目移回默认本）", role: .destructive) { Task { await onDelete() } }
            }
        }
    }
}

// MARK: - 条目行

private struct WrongItemRow: View {
    let item: WrongItem

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(item.topic ?? "未分类")
                    .font(.caption.bold())
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(topicColor.opacity(0.15))
                    .clipShape(Capsule())
                if item.status == "mastered" {
                    Text("✅ 已掌握").font(.caption2).foregroundStyle(.green)
                } else if isDue {
                    Text("⏰ 到期").font(.caption2).foregroundStyle(.red)
                }
                Text("Lv.\(item.level ?? 0)").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                if (item.wrong_count ?? 0) > 1 {
                    Text("×\(item.wrong_count!)").font(.caption2).foregroundStyle(.red)
                }
                Spacer()
                if let et = item.error_type, !et.isEmpty {
                    Text(et).font(.caption2).foregroundStyle(.orange)
                }
            }
            Text(item.text ?? "（题目已不存在）")
                .font(.callout)
                .lineLimit(2)
                .foregroundStyle(item.problem_exists == false ? .secondary : .primary)
            HStack(spacing: 8) {
                Text(sourceLabel).font(.caption2).foregroundStyle(.secondary)
                if let next = item.next_review_at {
                    Text("下次 \(fmtDate(next))").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var isDue: Bool {
        item.status != "mastered" && (item.next_review_at == nil || item.next_review_at! <= Date().timeIntervalSince1970)
    }

    private var topicColor: Color {
        item.status == "mastered" ? .green : (isDue ? .red : .brand)
    }

    private var sourceLabel: String {
        switch item.source {
        case "auto": return "🔴 答错自动收"
        case "manual": return "✍️ 手动加入"
        case "photo": return "📷 拍照录入"
        default: return item.source ?? ""
        }
    }
}

// MARK: - 条目详情

struct WrongItemDetail: View {
    let detail: ItemDetailResp
    let errorTypes: [String]
    let onRedo: () -> Void
    let onReview: (Bool) async -> Void
    let onMaster: (Bool) async -> Void
    let onMeta: (String?, String?) async -> Void
    let onRemove: () async -> Void

    @State private var note: String = ""
    @State private var imageData: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("错题详情").font(.headline)
                    Spacer()
                    Button(role: .destructive) { Task { await onRemove() } } label: {
                        Label("移出本子", systemImage: "trash")
                    }
                }

                let item = detail.item

                // 状态与等级
                HStack(spacing: 8) {
                    Text(detail.problem?.topic ?? item.topic ?? "未分类")
                        .font(.caption.bold())
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Color.brand.opacity(0.12)).clipShape(Capsule())
                    Text(levelText).font(.caption)
                    Text("复习 \(item.review_count ?? 0) 次").font(.caption).foregroundStyle(.secondary)
                    Text("做错 \(item.wrong_count ?? 0) 次").font(.caption).foregroundStyle(.red)
                    Spacer()
                    Button { Task { await onMaster(item.status != "mastered") } } label: {
                        Text(item.status == "mastered" ? "↩︎ 取消已掌握" : "✔︎ 标记已掌握")
                    }
                }

                // 完整题面
                if let p = detail.problem {
                    RichText(text: p.text ?? "")
                        .padding(12)
                        .background(Color.gray.opacity(0.06)).cornerRadius(10)
                    if let fig = p.figure, fig.type == "image" {
                        if let d = imageData, let img = ImageUtil.image(fromDataURL: d) {
                            ProblemFigureImage(image: img)
                        } else {
                            Button("查看题目原图") { Task { await loadImage() } }
                        }
                    } else if let fig = p.figure {
                        FigureView(figure: fig)
                    }
                } else {
                    Text("⚠️ 对应题目已从题库删除，仅剩错题记录").foregroundStyle(.secondary)
                }

                // 当时写错的答案
                if let wa = detail.wrong_answer {
                    HStack {
                        Text("当时写错：").font(.caption).foregroundStyle(.secondary)
                        Text(wa.answer ?? "").font(.callout.bold()).foregroundStyle(.red)
                        Text("（\(fmtDate(wa.at))）").font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(8)
                    .background(Color.red.opacity(0.06)).cornerRadius(8)
                }

                // 复习流水
                if let reviews = detail.reviews, !reviews.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("复习记录（只有「主动重做」推进等级）").font(.caption.bold())
                        ForEach(Array(reviews.enumerated()), id: \.offset) { pair in
                            let r = pair.element
                            HStack(spacing: 8) {
                                Text(r.correct ? "✅ 答对" : "❌ 答错").font(.caption)
                                Text(r.from_book == true ? "主动重做" : "日常作答").font(.caption2)
                                    .foregroundStyle(r.from_book == true ? Color.brand : Color.secondary)
                                Text("→ Lv.\(r.level_after ?? 0)").font(.caption2.monospacedDigit())
                                Spacer()
                                Text(fmtDate(r.at)).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(10)
                    .background(Color.gray.opacity(0.05)).cornerRadius(8)
                }

                // 错因标注
                VStack(alignment: .leading, spacing: 6) {
                    Text("错因标注").font(.caption.bold())
                    HStack(spacing: 6) {
                        ForEach([""] + errorTypes, id: \.self) { et in
                            Button(et.isEmpty ? "清空" : et) {
                                Task { await onMeta(et.isEmpty ? nil : et, note.isEmpty ? nil : note) }
                            }
                            .controlSize(.small)
                            .buttonStyle(.bordered)
                            .tint(item.error_type == et && !et.isEmpty ? .orange : .secondary)
                        }
                    }
                    TextEditor(text: $note)
                        .font(.callout)
                        .frame(height: 52)
                        .padding(4)
                        .background(Color.gray.opacity(0.08)).cornerRadius(8)
                    HStack {
                        if let n = item.note, !n.isEmpty { Text("已有备注：\(n)").font(.caption).foregroundStyle(.secondary) }
                        Spacer()
                        Button("保存备注") {
                            Task { await onMeta(nil, note.isEmpty ? "" : note) }
                        }
                        .controlSize(.small)
                    }
                }
                .padding(10)
                .background(Color.gray.opacity(0.05)).cornerRadius(8)

                // 行动
                HStack(spacing: 10) {
                    Button { onRedo() } label: {
                        Label("✏️ 去重做（计入复习等级）", systemImage: "arrow.counterclockwise")
                    }
                    .buttonStyle(.borderedProminent)

                    Text("在重做页答对会推进等级；这里也可以直接记结果：")
                        .font(.caption).foregroundStyle(.secondary)

                    Button("记一次答对") { Task { await onReview(true) } }
                    Button("记一次答错", role: .destructive) { Task { await onReview(false) } }
                }
            }
            .padding(14)
        }
        .onAppear {
            note = detail.item.note ?? ""
            imageData = nil
        }
    }

    private var levelText: String {
        let lv = detail.item.level ?? 0
        let streak = detail.item.review_streak ?? 0
        return detail.item.status == "mastered" ? "🎓 已毕业" : "等级 \(lv) · 连对 \(streak)"
    }

    private func loadImage() async {
        var q: [String: String] = [:]
        if AppModel.shared.user?.role == "parent" { q["studentId"] = AppModel.shared.viewStudentId ?? "" }
        if let r: ItemImageResp = try? await APIClient.shared.request("GET", "api/wrong-book/items/\(detail.item.id)/image", query: q.isEmpty ? nil : q, body: nil as [String: String]?) {
            imageData = r.image
        }
    }
}

// MARK: - 从题库挑题加入（candidates）

struct CandidatesPicker: View {
    let studentParam: String?
    let bookId: String?
    let onDone: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var keyword = ""
    @State private var problems: [ProblemRef] = []
    @State private var message: String?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 0) {
            Text("从题库挑题加入错题本").font(.headline).padding(12)
            HStack {
                TextField("搜索题面 / 主题", text: $keyword)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await load() } }
                Button("搜索") { Task { await load() } }
            }
            .padding(.horizontal, 12)

            List {
                ForEach(problems) { p in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(p.topic ?? "—").font(.caption.bold()).foregroundStyle(Color.brand)
                                if p.has_image == true { Text("🖼️").font(.caption) }
                                if p.in_book == true {
                                    Text(p.in_this_book == true ? "已在本子" : "已在错题本")
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                            Text(p.text ?? "").font(.callout).lineLimit(2)
                        }
                        Spacer()
                        Button(p.in_this_book == true ? "移到本子" : "加入") {
                            Task { await add(p) }
                        }
                        .controlSize(.small)
                        .disabled(busy)
                    }
                    .padding(.vertical, 2)
                }
            }
            .listStyle(.plain)

            if let m = message {
                Text(m).font(.footnote).foregroundStyle(.secondary).padding(6)
            }
            HStack {
                Spacer()
                Button("完成") {
                    onDone()
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
            .padding(12)
        }
        .frame(width: 640, height: 520)
        .onAppear { Task { await load() } }
    }

    private func load() async {
        var q: [String: String] = ["q": keyword]
        if let b = bookId { q["bookId"] = b }
        if let s = studentParam { q["studentId"] = s }
        guard let r: CandidatesResp = try? await APIClient.shared.request("GET", "api/wrong-book/candidates", query: q, body: nil as [String: String]?) else { return }
        problems = r.problems
    }

    private func add(_ p: ProblemRef) async {
        busy = true
        defer { busy = false }
        var q: [String: String] = [:]
        if let s = studentParam { q["studentId"] = s }
        let body: [String: AnyEncodable] = [
            "problemId": AnyEncodable(p.id),
            "bookId": AnyEncodable(bookId as String?),
        ]
        let r: AddItemsResp? = try? await APIClient.shared.request("POST", "api/wrong-book/items", query: q.isEmpty ? nil : q, body: body)
        message = r?.message ?? r?.error
        await load()
    }
}

// MARK: - 拍照录入（parse → 核对 → commit）

struct PhotoFlowDialog: View {
    @State var flow: PhotoFlowState
    let books: [WrongBook]
    let studentParam: String?
    let onDone: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var draft: PhotoDraft?
    @State private var parseError: String?
    @State private var busy = false
    @State private var bookId: String?
    @State private var keepImage = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("📷 拍照录入错题").font(.headline)

            if busy && draft == nil {
                HStack { ProgressView(); Text("识别中…（视觉模型可能需要十几秒）") }
                    .frame(maxWidth: .infinity).frame(height: 120)
            }

            if let e = parseError {
                Text(e).foregroundStyle(.red)
                Button("换一张") {
                    dismiss()
                    pickImage { url in
                        guard let img = NSImage(contentsOf: url),
                              let d = ImageUtil.jpegDataURL(from: img, maxEdge: 1600) else { return }
                        flow = PhotoFlowState(imageDataURL: d)
                        parseError = nil
                        Task { await parse() }
                    }
                }
            }

            if let d = Binding($draft) {
                PhotoDraftForm(draft: d, books: books, bookId: $bookId, keepImage: $keepImage, busy: busy,
                               onCancel: { dismiss() }, onCommit: { Task { await commit() } },
                               imageDataURL: flow.imageDataURL)
            }
        }
        .padding(16)
        .frame(width: 560, height: 560)
        .onAppear { Task { await parse() } }
    }

    private func parse() async {
        busy = true
        defer { busy = false }
        var q: [String: String] = [:]
        if let s = studentParam { q["studentId"] = s }
        do {
            let r: PhotoParseResp = try await APIClient.shared.request("POST", "api/wrong-book/photo/parse", query: q.isEmpty ? nil : q, body: ["image": flow.imageDataURL])
            if let d = r.draft {
                draft = d
                keepImage = d.has_figure
            } else {
                parseError = r.error ?? "识别失败"
            }
        } catch {
            parseError = error.localizedDescription
        }
    }

    private func commit() async {
        guard let d = draft else { return }
        busy = true
        defer { busy = false }
        var q: [String: String] = [:]
        if let s = studentParam { q["studentId"] = s }
        let body: [String: AnyEncodable] = [
            "draft": AnyEncodable(d),
            "image": AnyEncodable(keepImage ? flow.imageDataURL : nil),
            "keep_image": AnyEncodable(keepImage),
            "bookId": AnyEncodable(bookId as String?),
        ]
        do {
            let r: PhotoCommitResp = try await APIClient.shared.request("POST", "api/wrong-book/photo/commit", query: q.isEmpty ? nil : q, body: body)
            if r.ok {
                onDone("已录入：\(d.topic)")
                dismiss()
            } else {
                parseError = r.error ?? "保存失败"
            }
        } catch {
            parseError = error.localizedDescription
        }
    }
}

// MARK: - 拍照识别结果核对表单

private struct PhotoDraftForm: View {
    @Binding var draft: PhotoDraft
    let books: [WrongBook]
    @Binding var bookId: String?
    @Binding var keepImage: Bool
    let busy: Bool
    let onCancel: () -> Void
    let onCommit: () -> Void
    let imageDataURL: String

    init(draft: Binding<PhotoDraft>, books: [WrongBook], bookId: Binding<String?>, keepImage: Binding<Bool>, busy: Bool, onCancel: @escaping () -> Void, onCommit: @escaping () -> Void, imageDataURL: String = "") {
        self._draft = draft
        self.books = books
        self._bookId = bookId
        self._keepImage = keepImage
        self.busy = busy
        self.onCancel = onCancel
        self.onCommit = onCommit
        self.imageDataURL = imageDataURL
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let img = ImageUtil.image(fromDataURL: imageDataURL) {
                    // 同样是 ScrollView 里限高：直接 `scaledToFit + frame(maxHeight:)` 只会压
                    // 布局框，图仍按全宽绘制 → 压到下面的「主题」输入框上。用 FitBox 算准。
                    FitBox(natural: img.size, maxHeight: 130) {
                        Image(nsImage: img).resizable().interpolation(.high)
                    }
                    .cornerRadius(8)
                }
                LabeledContent("主题") {
                    TextField("主题", text: $draft.topic)
                }
                VStack(alignment: .leading) {
                    Text("题面（公式用 $...$）").font(.caption).foregroundStyle(.secondary)
                    TextEditor(text: $draft.text)
                        .font(.callout)
                        .frame(height: 90)
                        .padding(3)
                        .background(Color.gray.opacity(0.08)).cornerRadius(6)
                }
                LabeledContent("标准答案（必填）") {
                    TextField("标准答案", text: $draft.answer)
                }
                VStack(alignment: .leading) {
                    Text("提示（每行一条）").font(.caption).foregroundStyle(.secondary)
                    TextEditor(text: Binding(
                        get: { draft.hints.joined(separator: "\n") },
                        set: { draft.hints = $0.split(separator: "\n").map(String.init) }))
                        .font(.callout)
                        .frame(height: 60)
                        .padding(3)
                        .background(Color.gray.opacity(0.08)).cornerRadius(6)
                }
                Toggle("保留原图（题目含图形时勾选）", isOn: $keepImage)
                LabeledContent("加入本子") {
                    Picker("", selection: $bookId) {
                        Text("默认本").tag(String?.none)
                        ForEach(books.filter { !$0.is_default }) { b in
                            Text("\(b.emoji ?? "") \(b.name)").tag(String?.some(b.id))
                        }
                    }
                    .pickerStyle(.menu)
                }
            }
            .padding(4)
        }

        HStack {
            Button("取消", action: onCancel)
            Spacer()
            if busy { ProgressView().controlSize(.small) }
            Button("保存入本", action: onCommit)
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(draft.text.isEmpty || draft.answer.isEmpty || busy)
        }
    }
}
