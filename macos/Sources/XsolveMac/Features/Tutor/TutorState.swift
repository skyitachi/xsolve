import Foundation
import SwiftUI

// MARK: - 草稿笔画模型（与后端 scratch 契约一致：CSS 像素坐标）

struct StrokePoint: Codable, Equatable {
    var x: Double
    var y: Double
}

struct ScratchStroke: Codable, Equatable {
    var t: String        // pen | eraser
    var p: [StrokePoint]
}

// MARK: - 聊天条目

final class AiTextBlock: ObservableObject, Identifiable {
    let id = UUID()
    @Published var raw: String
    @Published var streaming: Bool
    init(raw: String = "", streaming: Bool = true) {
        self.raw = raw
        self.streaming = streaming
    }
}

final class ToolCardState: ObservableObject, Identifiable {
    let id = UUID()
    let label: String
    @Published var args: String
    @Published var result: String?
    @Published var isError = false
    @Published var running = true
    init(label: String, args: String) {
        self.label = label
        self.args = args
    }
}

/// 聊天条目。
///
/// ⚠️ id 必须是**存储属性**：早先写成 switch 里 `return UUID()` 的计算属性，
/// 导致 `ForEach` 每次重算都得到全新身份 → 每一行被当作新视图销毁重建 →
/// 每次重建都 new 一个 WKWebView（每个都拉起一个 WebContent 进程），
/// 打字/流式时进程数暴涨到几百个，最终新建 WKWebView 卡死在 IORegisterForSystemPower。
struct ChatEntry: Identifiable {
    enum Kind {
        case user(text: String, imageData: String?)
        case system(String)
        case error(String)
        case ai(AiTextBlock)
        case tool(ToolCardState)
        case diagram(url: String, title: String)
    }

    let id: UUID
    let kind: Kind

    init(_ kind: Kind, id: UUID = UUID()) {
        self.id = id
        self.kind = kind
    }

    // 静态工厂：让调用点仍可写 `.user(text:imageData:)` / `.ai(block)`
    static func user(text: String, imageData: String?) -> ChatEntry {
        ChatEntry(.user(text: text, imageData: imageData))
    }
    static func system(_ t: String) -> ChatEntry { ChatEntry(.system(t)) }
    static func error(_ t: String) -> ChatEntry { ChatEntry(.error(t)) }
    static func ai(_ b: AiTextBlock) -> ChatEntry { ChatEntry(.ai(b)) }
    static func tool(_ c: ToolCardState) -> ChatEntry { ChatEntry(.tool(c)) }
    static func diagram(url: String, title: String) -> ChatEntry {
        ChatEntry(.diagram(url: url, title: title))
    }
}

// MARK: - AI 状态指示器（chat.js AiStatus 的原生版）

enum AiStatusKind { case idle, thinking, tool, streaming, done, error, stalled }

final class AiStatus: ObservableObject {
    @Published var kind: AiStatusKind = .idle
    @Published var text = "待命"
    @Published var elapsed: Int = 0
    private var startedAt: Date?
    private var timer: Timer?

    func begin(_ t: String) {
        startedAt = Date()
        elapsed = 0
        set(.thinking, t)
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let s = self.startedAt else { return }
                self.elapsed = Int(Date().timeIntervalSince(s))
            }
        }
    }

    func tick(_ t: String, _ k: AiStatusKind = .thinking) { set(k, t) }

    func done() {
        timer?.invalidate()
        set(.done, "完成（\(elapsed)s）")
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            self?.reset()
        }
    }

    func fail(_ msg: String) {
        timer?.invalidate()
        set(.error, "出错：\(msg)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            self?.reset()
        }
    }

    func reset() {
        timer?.invalidate()
        set(.idle, "待命")
    }

    private func set(_ k: AiStatusKind, _ t: String) {
        kind = k
        text = t
    }
}

// MARK: - SSE 载荷结构

struct SdkMessage: Codable {
    let type: String?
    let event: StreamEvent?
    let message: AssistantMessage?
    let result: JSONValue?
    let usage: UsageInfo?
    let attempt: Int?
    let subtype: String?

    struct UsageInfo: Codable {
        let input_tokens: Int?
        let output_tokens: Int?
    }
}

struct StreamEvent: Codable {
    let type: String?
    let index: Int?
    let content_block: ContentBlockHead?
    let delta: StreamDelta?
    let deltas: [BatchDelta]?
}

struct BatchDelta: Codable {
    let index: Int?
    let delta: StreamDelta?
}

struct ContentBlockHead: Codable {
    let type: String?
    let id: String?
    let name: String?
}

struct StreamDelta: Codable {
    let type: String?
    let text: String?
    let partial_json: String?
}

struct AssistantMessage: Codable {
    let role: String?
    let content: [AssistantBlock]?
}

struct AssistantBlock: Codable {
    let type: String?
    let id: String?
    let name: String?
    let input: JSONValue?
    let content: JSONValue?
    let is_error: Bool?
    let tool_use_id: String?
}

// MARK: - 工具标签（chat.js TOOL_LABELS）

let TOOL_LABELS: [String: String] = [
    "list_problems": "📚 列出题库",
    "get_current_problem": "📖 读取当前题",
    "get_problem": "📖 读取题目",
    "set_current_problem": "🔀 切换题目",
    "delete_problem": "🗑️ 删除题目",
    "propose_problem": "🎯 出新题",
    "recognize_problem_image": "👁️ 视觉子代理识别",
    "recognize_scratch": "👁️ 识别草稿笔迹",
    "check_answer": "✅ 判答",
    "record_history": "💾 记录历史",
    "ability_report": "📊 水平评估",
    "read_scratch_state": "🖊️ 检查草稿",
    "calc": "🧮 计算",
    "generate_step_diagram": "📐 分步作图",
]

func prettyToolName(_ name: String) -> String {
    let short = name.replacingOccurrences(of: #"^mcp__[^_]+__"#, with: "", options: .regularExpression)
    return TOOL_LABELS[short] ?? "🔧 \(short)"
}

// MARK: - AI 出题提议（proposal 弹窗数据）

struct ProposedProblem: Codable, Identifiable {
    let id: String
    let topic: String?
    let text: String?
    let answer: String?
    let hints: [String]?
    let figure: ProblemFigure?
    let figureImage: String?
}

// MARK: - 做题主状态（index.html + chat.js + problem.js + scratch.js 的编排层）

@MainActor
final class TutorState: ObservableObject {
    let api = APIClient.shared
    let status = AiStatus()

    // 题目
    @Published var problems: [Problem] = []
    @Published var idx = 0

    // 会话
    @Published var sessionId: String?
    @Published var mode = UserDefaults.standard.string(forKey: "ai_mode") ?? "student"

    // 聊天
    @Published var entries: [ChatEntry] = []
    @Published var turnInFlight = false
    @Published var draftInput = ""   // 输入框正文：既是聊天输入，也是解答图的附言（Web 端同一个 textarea）
    // 最终答案输入框：做题区隐藏时 WorkPanel 会被销毁，草稿必须留在 state 里
    @Published var answerDraft = ""
    var pendingNewSession = false

    // 草稿
    let scratch = ScratchModel()

    // 上传
    @Published var pendingUpload: PendingImage?
    @Published var cropSource: String?          // 待裁剪的原图 dataURL
    var cropTarget: UploadTarget = .problem

    // 弹窗
    @Published var proposal: ProposedProblem?
    @Published var deleteProposal: (problem: ProposedProblem, fromAI: Bool)?
    @Published var showManualInput = false
    @Published var showAbout = false

    enum UploadTarget { case problem, answer }

    struct PendingImage {
        let dataURL: String
        let mediaType: String
        let base64: String
    }

    // 流式块状态（stream_event 用，按 index 归并）
    private struct BlockState {
        var kind: String = ""           // text | tool_use | thinking
        var textBlock: AiTextBlock?
        var toolCard: ToolCardState?
        var toolId: String = ""
    }
    private var blocks: [Int: BlockState] = [:]
    private var toolCards: [String: ToolCardState] = [:]
    private var activeTextBlock: AiTextBlock?
    private var textFinalized = false
    private var turnTask: Task<Void, Never>?

    var currentProblem: Problem? {
        problems.indices.contains(idx) ? problems[idx] : nil
    }

    // MARK: 启动

    func bootstrap(model: AppModel) async {
        await loadProblems()
        // 家长模式：按查看的孩子建会话
        var extra: [String: String] = [:]
        if mode == "parent", let sid = model.viewStudentId { extra["studentId"] = sid }
        if let saved = model.savedSessionId(mode: mode),
           let s: SessionInfo = try? await api.request("GET", "api/session/\(saved)", body: nil as [String: String]?) {
            sessionId = s.id
            mode = s.mode ?? mode
            if let pid = s.currentProblemId, let i = problems.firstIndex(where: { $0.id == pid }) {
                idx = i
            }
        } else {
            await createSession(extra: extra)
        }
        await loadHistory()
        // 错题本深链（重做）
        if let link = model.deepLink {
            model.deepLink = nil
            if let i = problems.firstIndex(where: { $0.id == link.problemId }) {
                idx = i
                if link.review {
                    _ = try? await api.requestOK("PATCH", "api/session/\(sessionId ?? "")", body: [
                        "currentProblemId": AnyEncodable(link.problemId), "review": AnyEncodable(true),
                    ])
                }
            }
        }
    }

    func loadProblems() async {
        guard let list: [Problem] = try? await api.request("GET", "api/problems", body: nil as [String: String]?) else { return }
        problems = list
        if idx >= list.count { idx = 0 }
    }

    func createSession(extra: [String: String]) async {
        var body = extra
        body["mode"] = mode
        if let s: SessionInfo = try? await api.request("POST", "api/session", body: body) {
            sessionId = s.id
            mode = s.mode ?? mode
            UserDefaults.standard.set(mode, forKey: "ai_mode")
            AppModel.shared.saveSessionId(s.id, mode: mode)
        }
    }

    func loadHistory() async {
        guard let sid = sessionId else { return }
        guard let resp: HistoryResp = try? await api.request("GET", "api/session/\(sid)/history", body: nil as [String: String]?) else { return }
        for t in resp.turns {
            if let u = t.userMessage, !u.isEmpty {
                entries.append(.user(text: u, imageData: nil))
            }
            if let a = t.aiMessage, !a.isEmpty {
                let block = AiTextBlock(raw: a, streaming: false)
                entries.append(.ai(block))
            }
        }
    }

    // MARK: 会话操作

    func switchMode(_ m: String) async {
        mode = m
        UserDefaults.standard.set(m, forKey: "ai_mode")
        entries = []
        var extra: [String: String] = [:]
        if m == "parent", let sid = AppModel.shared.viewStudentId { extra["studentId"] = sid }
        if let saved = AppModel.shared.savedSessionId(mode: m),
           let s: SessionInfo = try? await api.request("GET", "api/session/\(saved)", body: nil as [String: String]?) {
            sessionId = s.id
            if let pid = s.currentProblemId, let i = problems.firstIndex(where: { $0.id == pid }) { idx = i }
        } else {
            await createSession(extra: extra)
        }
        await loadHistory()
    }

    func clearHistory() async {
        guard let sid = sessionId else { return }
        _ = try? await api.requestOK("POST", "api/session/\(sid)/clear", body: Empty())
        entries = []
    }

    func newChatOverride() async {
        guard let old = sessionId else { return }
        var body: [String: String] = ["mode": mode]
        if mode == "parent", let sid = AppModel.shared.viewStudentId { body["studentId"] = sid }
        if let s: SessionInfo = try? await api.request("POST", "api/session/\(old)/reset", body: body) {
            sessionId = s.id
            mode = s.mode ?? mode
            AppModel.shared.saveSessionId(s.id, mode: mode)
            entries = []
        }
    }

    // MARK: 题目导航 / 同步

    func goPrev() { nav(delta: -1) }
    func goNext() { nav(delta: 1) }

    private func nav(delta: Int) {
        guard !problems.isEmpty else { return }
        idx = ((idx + delta) % problems.count + problems.count) % problems.count
        syncCurrentProblem()
    }

    func syncCurrentProblem(review: Bool? = nil) {
        guard let p = currentProblem, let sid = sessionId else { return }
        var body: [String: AnyEncodable] = ["currentProblemId": AnyEncodable(p.id)]
        if let r = review { body["review"] = AnyEncodable(r) }
        Task { _ = try? await api.requestOK("PATCH", "api/session/\(sid)", body: body) }
    }

    func refreshProblemsAfterChange(currentId: String?, deletedId: String?) async {
        await loadProblems()
        if let deletedId {
            systemMsg("🗑️ 已删除题目 \(deletedId)，切换到新题目后将开始新会话。")
        }
        if problems.isEmpty {
            systemMsg("题库已空。可以让 AI 出一道新题。")
            idx = 0
            return
        }
        let wantId = currentId ?? problems.first?.id
        let found = problems.firstIndex { $0.id == wantId }
        idx = found ?? 0
        if deletedId != nil { pendingNewSession = true }
    }

    // MARK: 消息辅助

    func systemMsg(_ t: String) { entries.append(.system(t)) }
    func errorMsg(_ t: String) { entries.append(.error(t)) }
    func userMsg(_ t: String, image: String? = nil) { entries.append(.user(text: t, imageData: image)) }

    // MARK: 提交答案（submitAnswer 语义：显式锚定当前题）

    func submitAnswer(_ answer: String) async {
        guard !answer.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let cp = currentProblem
        let anchor = cp.map { "（当前题目 id 是 \($0.id)，请只按这道题判答，不要用历史里的其它题目 id）" } ?? ""
        userMsg("我的答案是：\(answer)")
        await runTurn("请用工具 check_answer 判断我的答案\"\(answer)\"是否正确\(anchor)，然后记录到我的历史，并给我反馈。如果错了请给我提示，不要直接告诉我答案。")
    }

    // MARK: runTurn（SSE 流式对话）

    func runTurn(_ text: String, image: PendingImage? = nil, audio: (mediaType: String, data: String)? = nil) async {
        guard !turnInFlight else {
            systemMsg("⏳ AI正在处理中，请稍候再发送...")
            return
        }
        guard sessionId != nil else {
            errorMsg("会话尚未就绪，请稍候重试。")
            return
        }
        turnInFlight = true
        defer { turnInFlight = false }

        let hasMedia = image != nil || audio != nil
        status.begin(hasMedia ? "正在上传媒体…" : "思考中…")

        // 草稿先同步（有笔迹时连图片一起传，让 recognize_scratch / 自动识别可用）
        let scratchSynced = await syncScratchToServer()
        if !scratchSynced && scratch.strokes.count > 0 {
            systemMsg("⚠️ 草稿没能上传成功，这一轮 AI 可能看不到你写的过程（网络或会话异常，可重试一次）。")
        }

        blocks = [:]
        toolCards = [:]
        activeTextBlock = nil
        textFinalized = false

        var streamDone = false
        var streamAborted = false

        let stream = api.streamTurn(
            sessionId: sessionId!,
            message: text,
            image: image.map { ($0.mediaType, $0.base64) },
            audio: audio,
            currentProblemId: currentProblem?.id,
            scratchStrokes: scratch.strokes.count)

        do {
            if image != nil { status.tick("模型识别图片中…") }
            else if audio != nil { status.tick("模型识别语音中…") }
            for try await ev in stream {
                switch ev.event {
                case "user":
                    break
                case "sdk_message":
                    let msg = (try? JSONDecoder().decode(SdkMessage.self, from: ev.data)) ?? SdkMessage(type: nil, event: nil, message: nil, result: nil, usage: nil, attempt: nil, subtype: nil)
                    handleSdkMessage(msg)
                case "ui_event":
                    handleUiEvent(ev.data)
                case "aborted":
                    streamAborted = true
                case "error":
                    let m = (try? JSONDecoder().decode([String: JSONValue].self, from: ev.data))?["message"]?.stringValue
                    errorMsg(m ?? "未知错误")
                    status.fail(m ?? "未知")
                    pendingNewSession = false
                case "done":
                    streamDone = true
                    status.done()
                    if pendingNewSession {
                        pendingNewSession = false
                        Task {
                            var extra: [String: String] = [:]
                            if mode == "parent", let sid = AppModel.shared.viewStudentId { extra["studentId"] = sid }
                            await createSession(extra: extra)
                            systemMsg("💬 新对话已开启（切换题目不清除历史记录）。")
                        }
                    }
                default:
                    break
                }
            }
            if streamAborted {
                systemMsg("⏹️ 已取消当前回复。")
                status.done()
            } else if !streamDone {
                errorMsg("连接异常中断：AI 未返回完整结果，请重试。")
                status.fail("连接中断")
            }
        } catch {
            if error is CancellationError {
                systemMsg("⏹️ 已取消当前回复。")
                status.done()
            } else {
                errorMsg("请求失败：\n\(error.localizedDescription)")
                status.fail(error.localizedDescription)
            }
        }
    }

    func cancelTurn() {
        // Web 端也是「本地断流」：AbortController.abort() 关掉 SSE 连接，
        // 服务端在 res.on('close') 里感知并停掉 SDK 流（后端并无 /abort 路由）
        turnTask?.cancel()
    }

    // MARK: SDK 消息处理（对齐 chat.js handleSdkMessage / handleStreamEvent）

    private func handleSdkMessage(_ msg: SdkMessage) {
        guard let type = msg.type else { return }
        if type == "stream_event", let ev = msg.event {
            handleStreamEvent(ev)
            return
        }
        if type == "assistant", let content = msg.message?.content {
            // 兜底：partial 流里没出现过的 tool_use 补一张卡
            for block in content where block.type == "tool_use" {
                if let id = block.id, toolCards[id] == nil {
                    let card = ToolCardState(label: prettyToolName(block.name ?? ""), args: block.input?.pretty ?? "")
                    card.running = false
                    card.result = ""
                    toolCards[id] = card
                    entries.append(.tool(card))
                }
            }
        } else if type == "user", let content = msg.message?.content {
            for block in content where block.type == "tool_result" {
                guard let tuid = block.tool_use_id, let card = toolCards[tuid] else { continue }
                var payload: String
                if case .array(let arr)? = block.content {
                    payload = arr.map { item -> String in
                        if case .string(let s) = item { return s }
                        return item.pretty
                    }.joined(separator: "\n")
                } else {
                    payload = block.content?.pretty ?? ""
                }
                card.result = payload.isEmpty ? "（无输出）" : payload
                card.isError = block.is_error ?? false
                card.running = false
            }
        } else if type == "result" {
            finishActiveText()
            if activeTextBlock == nil || !textFinalized {
                if case .string(let s)? = msg.result, !s.trimmingCharacters(in: .whitespaces).isEmpty {
                    // 文本未被流式传输（多轮工具调用后只在 result 返回）
                    let block = AiTextBlock(raw: s, streaming: false)
                    entries.append(.ai(block))
                    activeTextBlock = block
                }
            }
        } else if type == "api_retry" {
            status.tick("模型繁忙，正在重试（第 \(msg.attempt.map(String.init) ?? "?") 次）…")
        } else if type == "status" {
            if let sub = msg.subtype,
               sub.range(of: "throttl|retry|slow", options: .regularExpression) != nil {
                status.tick("服务较慢，请稍候…")
            }
        }
    }

    private func handleStreamEvent(_ ev: StreamEvent) {
        guard let type = ev.type else { return }
        switch type {
        case "message_start":
            blocks = [:]
            activeTextBlock = nil
            textFinalized = false
        case "content_block_start":
            let cb = ev.content_block
            let kind = cb?.type ?? ""
            if kind == "text" {
                let block = AiTextBlock()
                entries.append(.ai(block))
                blocks[ev.index ?? -1] = BlockState(kind: "text", textBlock: block, toolCard: nil, toolId: "")
                activeTextBlock = block
                textFinalized = false
                status.tick("AI 正在回答…", .streaming)
            } else if kind == "tool_use" {
                let card = ToolCardState(label: prettyToolName(cb?.name ?? ""), args: "")
                if let id = cb?.id { toolCards[id] = card }
                entries.append(.tool(card))
                blocks[ev.index ?? -1] = BlockState(kind: "tool_use", textBlock: nil, toolCard: card, toolId: cb?.id ?? "")
                status.tick("调用工具 \(card.label) …", .tool)
            } else if kind == "thinking" {
                blocks[ev.index ?? -1] = BlockState(kind: "thinking")
                status.tick("深度思考中…")
            }
        case "content_block_delta":
            if let i = ev.index, let d = ev.delta {
                applyDelta(index: i, delta: d)
            }
        case "content_block_deltas_batch":
            for item in ev.deltas ?? [] {
                if let i = item.index, let d = item.delta {
                    applyDelta(index: i, delta: d)
                }
            }
        case "content_block_stop":
            if let i = ev.index, let b = blocks[i], b.kind == "text", let tb = b.textBlock {
                tb.streaming = false
                textFinalized = true
            }
        default:
            break
        }
    }

    private func applyDelta(index: Int, delta: StreamDelta) {
        guard let b = blocks[index] else { return }
        if b.kind == "text", delta.type == "text_delta", let t = delta.text {
            b.textBlock?.raw += t
            blocks[index] = b
            status.tick("AI 正在回答…", .streaming)
        } else if b.kind == "tool_use", delta.type == "input_json_delta", let j = delta.partial_json {
            b.toolCard?.args += j
            blocks[index] = b
        }
    }

    private func finishActiveText() {
        for (_, b) in blocks {
            if b.kind == "text", b.textBlock === activeTextBlock {
                activeTextBlock?.streaming = false
                return
            }
        }
    }

    // MARK: UI 事件（后端 ui_event）

    private func handleUiEvent(_ data: Data) {
        guard let obj = try? JSONDecoder().decode([String: JSONValue].self, from: data),
              let type = obj["type"]?.stringValue else { return }
        switch type {
        case "set_problem":
            if let pid = obj["problem_id"]?.stringValue,
               let i = problems.firstIndex(where: { $0.id == pid }), i != idx {
                idx = i
                systemMsg("AI 已为你切换到第 \(i + 1) 题")
            }
        case "problem_proposed":
            if let p = try? JSONDecoder().decode(ProposedProblem.self, from: data) {
                proposal = p
            }
        case "delete_proposed":
            if let p = try? JSONDecoder().decode(ProposedProblem.self, from: data) {
                deleteProposal = (p, true)
            }
        case "problems_changed":
            let cur = obj["current_problem_id"]?.stringValue
            let del = obj["deleted_id"]?.stringValue
            Task { await refreshProblemsAfterChange(currentId: cur, deletedId: del) }
        case "vision_subagent_started":
            status.tick("视觉子代理识别中（\(obj["model"]?.stringValue ?? "vision")）…", .tool)
        case "vision_subagent_done":
            status.tick("视觉子代理完成，主代理继续…")
        case "scratch_recognition_started":
            status.tick("正在识别草稿笔迹（\(obj["model"]?.stringValue ?? "vision")）…", .tool)
        case "scratch_recognition_done":
            status.tick("草稿识别完成，AI 分析中…")
        case "diagram_generated":
            let url = obj["url"]?.stringValue ?? ""
            let title = obj["title"]?.stringValue ?? "分步作图"
            if !url.isEmpty { entries.append(.diagram(url: url, title: title)) }
        default:
            break
        }
    }

    // MARK: 草稿同步（scratch.js syncScratchToServer）

    /// 返回 false = 有笔画但没能完整送到服务端（此时 AI 看不到草稿，
    /// 却会回一句「草稿板是空的」，用户只会觉得「识别坏了」—— 必须报出来）
    @discardableResult
    func syncScratchToServer() async -> Bool {
        guard let sid = sessionId else { return false }
        let count = scratch.strokes.count
        var ok = true
        do { _ = try await api.requestOK("POST", "api/session/\(sid)/scratch", body: ["strokes": count]) }
        catch { ok = false }
        if count > 0 {
            guard let dataURL = scratch.exportImage() else { return false }
            do {
                _ = try await api.requestOK("POST", "api/session/\(sid)/scratch-image", body: [
                    "image": AnyEncodable(dataURL), "strokes": AnyEncodable(count),
                ])
            } catch { ok = false }
        } else {
            do {
                _ = try await api.requestOK("POST", "api/session/\(sid)/scratch-image", body: [
                    "image": AnyEncodable(nil as String?), "strokes": AnyEncodable(0),
                ])
            } catch { ok = false }
        }
        return ok
    }

    // MARK: 识别草稿按钮

    func recognizeScratch() async {
        guard !turnInFlight else {
            systemMsg("⏳ AI正在处理中，请稍候...")
            return
        }
        guard scratch.strokes.count > 0 else {
            systemMsg("📝 草稿板是空的，先在草稿区写点东西再识别吧。")
            return
        }
        userMsg("👁️ 请看看我草稿上写了什么")
        await runTurn("请调用 recognize_scratch 工具识别我草稿板上的手写内容，告诉我我在草稿上写了什么算式和答案，帮我检查演算过程是否正确。如果发现错误，请用提问的方式引导我自己发现，不要直接告诉我正确答案。")
    }

    // MARK: 上传流转（upload.js 语义）

    static let problemRecognizePrompt = "这是一道题目的图片。请仔细识别图片里的题面（有公式就用 LaTeX $...$ 表示），判断主题类型，然后调用 propose_problem 工具向我提议这道新题。注意：你只需识别题目并出题，不要在对话里解答题目或给出答案/解题步骤；答案和提示作为 propose_problem 的参数提交即可（不会在对话里展示）。你不必自己切换题目；propose_problem 会弹窗让我确认是否替换当前题。如果原图含有题目相关图形，务必设 figure: {type:\"image\"}。"

    /// 附言留空时用的默认话术（与 Web 端 upload.js 完全一致）
    static let answerDefaultPrompt = "这是我写在纸上的做题过程 / 答案，请帮我看看对不对、有没有需要改进的地方。"

    /// 原始图片进入：题目 → 裁剪后立即识别；解答 → 缩放进预览等确认
    func ingest(image dataURL: String, target: UploadTarget) {
        switch target {
        case .problem:
            cropSource = dataURL
            cropTarget = .problem
        case .answer:
            guard let parts = ImageUtil.parseDataURL(dataURL) else { return }
            pendingUpload = PendingImage(dataURL: dataURL, mediaType: parts.mediaType, base64: parts.base64)
        }
    }

    func confirmCrop(_ cropped: String) {
        guard let parts = ImageUtil.parseDataURL(cropped) else { return }
        userMsg("（上传题目图片，请识别为新题）", image: cropped)
        let img = PendingImage(dataURL: cropped, mediaType: parts.mediaType, base64: parts.base64)
        Task { await runTurn(Self.problemRecognizePrompt, image: img) }
    }

    /// 附言 → 真正发给 AI 的 prompt（纯函数，方便探针直接断言）
    static func pendingUploadPrompt(draft: String) -> (caption: String, prompt: String) {
        let caption = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return (caption, caption.isEmpty ? answerDefaultPrompt : caption)
    }

    /// 发送待发的解答图。附言取**输入框正文**（与 Web 端 upload.js 的
    /// `elChatInput.value.trim()` 一致）：输入框里已经打的问题直接当附言用，
    /// 发完清空 —— 否则用户打完字再点「发给 AI 检查」，那段文字要么丢掉、
    /// 要么被当成下一条独立提问，都是错的。
    func sendPendingUpload() async {
        guard let up = pendingUpload else { return }
        let (caption, prompt) = Self.pendingUploadPrompt(draft: draftInput)
        // Web 端是 addUserMsg(caption || prompt, ...)：没附言就把默认话术显示出来
        userMsg(caption.isEmpty ? prompt : caption, image: up.dataURL)
        pendingUpload = nil
        draftInput = ""
        await runTurn(prompt, image: up)
    }

    // MARK: 确认弹窗回调

    func acceptProposal() async {
        guard let p = proposal else { return }
        _ = try? await api.requestOK("POST", "api/session/\(sessionId ?? "")/proposal", body: [
            "action": "accept", "problem_id": p.id,
        ])
        proposal = nil
        await refreshProblemsAfterChange(currentId: p.id, deletedId: nil)
    }

    func cancelProposal() async {
        guard let p = proposal else { return }
        _ = try? await api.requestOK("POST", "api/session/\(sessionId ?? "")/proposal", body: [
            "action": "cancel", "problem_id": p.id,
        ])
        proposal = nil
    }

    func acceptDelete() async {
        guard let (p, fromAI) = deleteProposal else { return }
        _ = try? await api.requestOK("POST", "api/session/\(sessionId ?? "")/delete-confirm", body: [
            "action": "accept", "problem_id": p.id,
        ])
        deleteProposal = nil
        if !fromAI {
            // 手动删除：走 DELETE /api/problem/:id（管理员）或依赖 ui_event
            if AppModel.shared.user?.is_admin == true {
                _ = try? await api.requestOK("DELETE", "api/problem/\(p.id)")
                await refreshProblemsAfterChange(currentId: nil, deletedId: p.id)
            }
        }
    }

    func cancelDelete() async {
        guard let (p, _) = deleteProposal else { return }
        _ = try? await api.requestOK("POST", "api/session/\(sessionId ?? "")/delete-confirm", body: [
            "action": "cancel", "problem_id": p.id,
        ])
        deleteProposal = nil
    }
}

// MARK: - 草稿模型（scratch.js：留全量笔画以支持撤销 / 重放 / 导出）

@MainActor
final class ScratchModel: ObservableObject {
    @Published var strokes: [ScratchStroke] = []
    @Published var tool: String = "pen"    // pen | eraser

    // 常量对非 MainActor 上下文（如画布光标构造）也要可读，否则 Swift 6 模式下是硬错误
    nonisolated static let penWidth: CGFloat = 2.6
    nonisolated static let eraserWidth: CGFloat = 18

    var strokeColor: (color: Color, width: CGFloat) {
        tool == "eraser" ? (Color.paperBG, Self.eraserWidth) : (Color(hex: 0x1F2937), Self.penWidth)
    }

    func append(point: StrokePoint) {
        strokes.append(ScratchStroke(t: tool, p: [point]))
    }

    func extendLast(point: StrokePoint) {
        guard var s = strokes.popLast() else { return }
        s.p.append(point)
        strokes.append(s)
    }

    func undo() {
        guard !strokes.isEmpty else { return }
        strokes.removeLast()
    }

    func clear() {
        strokes = []
    }

    /// 墨迹包围盒（跳过橡皮：它只覆盖不加墨），用于导出时裁掉大片空白
    func inkBounds(padding: CGFloat = 16) -> CGRect? {
        var minX = Double.infinity, minY = Double.infinity
        var maxX = -Double.infinity, maxY = -Double.infinity
        for s in strokes where s.t != "eraser" {
            for pt in s.p {
                minX = min(minX, pt.x); minY = min(minY, pt.y)
                maxX = max(maxX, pt.x); maxY = max(maxY, pt.y)
            }
        }
        guard minX.isFinite, minY.isFinite, maxX.isFinite, maxY.isFinite else { return nil }
        let pad = padding + Self.penWidth
        return CGRect(x: minX - pad, y: minY - pad,
                      width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2)
    }

    /// 导出白底黑字 JPEG（exportScratchImage 语义）
    ///
    /// 三个都是「识别不出来」的真凶，缺一个都会让视觉模型读成涂鸦：
    /// 1. 位图上下文是**左下原点**，笔画存的是左上原点 —— 不翻转就得到上下颠倒的图
    ///    （旧断言只数「有没有深色像素」，颠倒的图照样有，所以一直没暴露；
    ///    症状是 9 被读成 6）。
    /// 2. 整块画布导出时大部分是空白，模型降采样后字只剩几个像素。
    ///    → 按墨迹包围盒裁剪。
    /// 3. 1x 导出时 2.6pt 的细笔只有两条像素。→ 按长边缩放到 ~1000px。
    func exportImage(scale: CGFloat = 2, targetLongEdge: CGFloat = 1000) -> String? {
        guard let canvas = canvasSize, canvas.width > 2, canvas.height > 2 else { return nil }
        var region = inkBounds().map { $0.intersection(CGRect(origin: .zero, size: canvas)) } ?? CGRect(origin: .zero, size: canvas)
        if region.width < 8 || region.height < 8 {
            region = CGRect(origin: .zero, size: canvas)
        }
        // 缩放：让长边落在 targetLongEdge 附近（小字放大、大字不无限放大）
        let long = max(region.width, region.height)
        var s = long < 1 ? scale : targetLongEdge / long
        s = min(max(s, 1), scale * 1.5)
        let w = Int((region.width * s).rounded()), h = Int((region.height * s).rounded())
        guard w > 2, h > 2 else { return nil }
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let gctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = gctx
        let cg = gctx.cgContext
        cg.setFillColor(NSColor.white.cgColor)
        cg.fill(CGRect(x: 0, y: 0, width: w, height: h))
        // 裁出 region → 翻成左上原点 → 放大：之后 render 里就能直接用画布点坐标
        cg.translateBy(x: 0, y: CGFloat(h))
        cg.scaleBy(x: s, y: -s)
        cg.translateBy(x: -region.minX, y: -region.minY)
        render(in: region)
        NSGraphicsContext.restoreGraphicsState()
        guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.9]) else { return nil }
        return "data:image/jpeg;base64," + data.base64EncodedString()
    }

    /// 草稿上屏绘制（SwiftUI Canvas 专用）。
    /// ⚠️ 不能用 render(in:)：Canvas 的绘制闭包里 NSGraphicsContext.current 是 nil，
    /// 那条路径会静默 return —— 画布永远是一张白纸（导出能出图，屏幕上却什么都没有）。
    func draw(in ctx: GraphicsContext) {
        for s in strokes {
            let isEraser = s.t == "eraser"
            let color = isEraser ? Color.paperBG : Color(hex: 0x1F2937)
            let w = isEraser ? Self.eraserWidth : Self.penWidth
            if s.p.count == 1 {
                let r = w / 2
                let rect = CGRect(x: s.p[0].x - r, y: s.p[0].y - r, width: w, height: w)
                ctx.fill(Path(ellipseIn: rect), with: .color(color))
            } else {
                var path = Path()
                path.move(to: CGPoint(x: s.p[0].x, y: s.p[0].y))
                for pt in s.p.dropFirst() {
                    path.addLine(to: CGPoint(x: pt.x, y: pt.y))
                }
                ctx.stroke(path, with: .color(color),
                           style: StrokeStyle(lineWidth: w, lineCap: .round, lineJoin: .round))
            }
        }
    }

    /// 笔画重放（导出 / 位图上下文用；必须由调用方先把 NSGraphicsContext.current 设好）
    /// 坐标按「画布点坐标、左上原点」写；调用方负责把上下文翻成左上原点（见 exportImage）。
    func render(in rect: CGRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        // 导出铺的是纯白底，橡皮就用白色盖 —— 纸色在这里会留下一道比背景更暗的痕
        let eraser = NSColor.white.cgColor
        let ink = NSColor(hex: 0x1F2937).cgColor
        for s in strokes {
            let isEraser = s.t == "eraser"
            ctx.setStrokeColor(isEraser ? eraser : ink)
            ctx.setFillColor(isEraser ? eraser : ink)
            ctx.setLineWidth(isEraser ? Self.eraserWidth : Self.penWidth)
            ctx.setLineCap(.round)
            ctx.setLineJoin(.round)
            if s.p.count == 1 {
                let pt = CGPoint(x: s.p[0].x, y: s.p[0].y)
                let r = (isEraser ? Self.eraserWidth : Self.penWidth) / 2
                ctx.fillEllipse(in: CGRect(x: pt.x - r, y: pt.y - r, width: r * 2, height: r * 2))
            } else {
                ctx.beginPath()
                ctx.move(to: CGPoint(x: s.p[0].x, y: s.p[0].y))
                for pt in s.p.dropFirst() {
                    ctx.addLine(to: CGPoint(x: pt.x, y: pt.y))
                }
                ctx.strokePath()
            }
        }
    }

    /// 画布逻辑尺寸（由视图回填；导出用）
    var canvasSize: CGSize?
}

private extension NSColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255,
                  green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
