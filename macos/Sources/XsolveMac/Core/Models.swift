import Foundation

// MARK: - 容错主键
//
// 同一个字段后端可能给整数也可能给字符串（例如 student_attempts.id 视建表方式而定）。
// 用它接住两种形态，避免一个字段的类型漂移让整页解码失败、界面静默空白。

struct FlexID: Codable, Hashable, CustomStringConvertible {
    let raw: String

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let i = try? c.decode(Int.self) {
            raw = String(i)
        } else if let s = try? c.decode(String.self) {
            raw = s
        } else if let d = try? c.decode(Double.self) {
            raw = String(Int(d))
        } else {
            throw DecodingError.typeMismatch(
                FlexID.self,
                .init(codingPath: decoder.codingPath,
                      debugDescription: "期望 int 或 string"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        if let i = Int(raw) { try c.encode(i) } else { try c.encode(raw) }
    }

    var description: String { raw }
}

// MARK: - 动态 JSON 值（工具入参 / 任意结构容错）

enum JSONValue: Codable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    var doubleValue: Double? { if case .number(let n) = self { return n }; return nil }
    var intValue: Int? { if case .number(let n) = self { return Int(n) }; return nil }

    /// 格式化为多行 JSON（工具卡片展示参数用）
    var pretty: String {
        switch self {
        case .string(let s): return s
        default:
            let enc = JSONEncoder()
            enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            guard let d = try? enc.encode(self), let s = String(data: d, encoding: .utf8) else { return "\(self)" }
            return s
        }
    }
}

// MARK: - 用户 / 认证

struct Child: Codable, Identifiable, Hashable {
    let id: String
    let username: String
    let display_name: String?
    let relation: String?
    var stats: ChildStats?
}

struct User: Codable, Identifiable, Hashable {
    let id: String
    let role: String            // student | parent | admin
    let username: String
    let display_name: String?
    let is_admin: Bool
    let status: String?
    let created_at: Double?
    let last_login_at: Double?
    let guest_expires_at: Double?
    let is_guest: Bool?
    var children: [Child]?
    // 管理页的运营统计（listUsersWithStats 附加字段）
    var session_count: Int?
    var child_count: Int?
    var parent_count: Int?
    var attempt_count: Int?
    var correct_count: Int?

    var label: String { display_name ?? username }
    var roleText: String { role == "parent" ? "家长" : (is_admin ? "管理员" : "学生") }
}

struct ChildStats: Codable, Hashable {
    let student_id: String?
    let session_count: Int?
    let attempt_count: Int?
    let correct_count: Int?
    let rate: Int?
    let topic_count: Int?
    let avg_mastery: Int?
    let level: String?
    let last_active: Double?
}

struct LoginResp: Codable { let ok: Bool; let user: User; let guest_expires_at: Double? }
struct SimpleOK: Codable { let ok: Bool; let note: String?; let error: String? }
struct InviteResp: Codable { let ok: Bool; let code: String; let kind: String; let expires_at: Double?; let student_id: String?; let error: String? }
struct InviteRow: Codable, Identifiable {
    var id: String { code }
    let code: String
    let kind: String
    let target_student_id: String?
    let expires_at: Double?
    let used_by: String?
    let created_at: Double?
    let expired: Bool?
}
struct InvitesResp: Codable { let invites: [InviteRow] }
struct BindCodeRow: Codable, Identifiable {
    var id: String { code }
    let code: String
    let expires_at: Double?
    let expired: Bool?
    let created_at: Double?
}
struct BindCodesResp: Codable { let student_id: String; let codes: [BindCodeRow] }

// MARK: - 题目

struct ProblemFigure: Codable, Hashable {
    let type: String
    let width: Double?
    let height: Double?
    let unit: String?
    let a: Double?
    let b: Double?
}

struct Problem: Codable, Identifiable, Hashable {
    let id: String
    let topic: String
    let text: String
    let figure: ProblemFigure?
    let figureImage: String?   // dataURL（仅 /api/problems 返回；candidates 列表已剥除）
}

struct ProblemRef: Codable, Identifiable, Hashable {
    let id: String
    let topic: String?
    let text: String?
    let has_image: Bool?
    let in_book: Bool?
    let in_this_book: Bool?
    let item_id: String?
}

// MARK: - 会话 / 聊天

struct SessionInfo: Codable {
    let id: String
    let mode: String?
    let studentId: String?
    let currentProblemId: String?
    let createdAt: Double?
    let ok: Bool?
}

struct ToolCallRecord: Codable, Hashable {
    let name: String?
    let input: JSONValue?
}

struct TurnRecord: Codable, Identifiable {
    let id: String
    let userMessage: String?
    let aiMessage: String?
    let toolCalls: [ToolCallRecord]?
    let inputTokens: Int?
    let outputTokens: Int?
    let durationMs: Int?
    let error: String?
    let createdAt: Double?
}

struct HistoryResp: Codable {
    struct SessionMeta: Codable { let id: String; let role: String?; let title: String?; let currentProblemId: String? }
    let session: SessionMeta
    let turns: [TurnRecord]
}

struct SessionRow: Codable, Identifiable {
    let id: String
    let role: String?
    let title: String?
    let currentProblemId: String?
    let createdAt: Double?
    let updatedAt: Double?
}

// MARK: - 错题本

struct WrongBook: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let emoji: String?
    let is_default: Bool
    let created_at: Double?
    let total: Int?
    let pending: Int?
}

struct WrongBookStats: Codable, Hashable {
    let books: Int?
    let total: Int?
    let pending: Int?
    let mastered: Int?
    let due: Int?
    let overdue_days: Int?
    let next_due_at: Double?
    let last7_mastered: Int?
    let by_source: [String: Int]?
    let by_error: [String: Int]?
}

struct WrongItem: Codable, Identifiable, Hashable {
    let id: String
    let book_id: String?
    let problem_id: String
    let source: String?
    let status: String?
    let wrong_count: Int?
    let review_count: Int?
    let level: Int?
    let review_streak: Int?
    let note: String?
    let error_type: String?
    let error_source: String?
    let created_at: Double?
    let first_wrong_at: Double?
    let last_review_at: Double?
    let last_correct_at: Double?
    let next_review_at: Double?
    let mastered_at: Double?
    let topic: String?
    let text: String?
    let has_image: Bool?
    let has_figure: Bool?
    let problem_exists: Bool?
}

struct WrongReviewRow: Codable, Hashable {
    let correct: Bool
    let from_book: Bool?
    let level_after: Int?
    let at: Double?
}

struct WrongAnswerRow: Codable, Hashable { let answer: String?; let at: Double? }

struct BooksResp: Codable { let books: [WrongBook]; let stats: WrongBookStats }
struct ItemsResp: Codable {
    let items: [WrongItem]
    let due_total: Int?
    let daily_limit: Int?
    let error_types: [String]?
}
struct ItemDetailResp: Codable {
    struct ProblemFull: Codable { let id: String; let topic: String?; let text: String?; let figure: ProblemFigure? }
    let item: WrongItem
    let problem: ProblemFull?
    let wrong_answer: WrongAnswerRow?
    let reviews: [WrongReviewRow]?
    let error_types: [String]?
}
struct AddItemsResp: Codable { let ok: Bool; let added: Int?; let already: Int?; let skipped: [String]?; let message: String?; let error: String? }
struct CandidatesResp: Codable { let problems: [ProblemRef] }
struct PhotoDraft: Codable, Hashable {
    var topic: String
    var text: String
    var answer: String
    var hints: [String]
    var has_figure: Bool
}
struct PhotoParseResp: Codable { let ok: Bool; let draft: PhotoDraft?; let error: String?; let raw: String? }
struct PhotoCommitResp: Codable { let ok: Bool; let created: Bool?; let item: WrongItem?; let error: String? }
struct ItemImageResp: Codable { let image: String }
struct ReviewResp: Codable { let ok: Bool; let item: WrongItem?; let graduated: Bool?; let correct: Bool?; let error_types: [String]?; let error: String? }
struct DueSummary: Codable { let due: Int; let topics: [TopicCount] }
struct TopicCount: Codable, Hashable { let topic: String; let n: Int }

// MARK: - 学习档案

struct MemoryStats: Codable, Hashable { let total: Int; let correct: Int; let rate: Int; let last_at: Double? }
struct MasteryRow: Codable, Hashable, Identifiable {
    var id: String { topic }
    let topic: String
    let mastery: Int
    let attempts: Int
    let correct: Int
    let last_seen: Double?
}
struct AttemptRow: Codable, Hashable, Identifiable {
    let id: FlexID
    let session_id: String?
    let turn_id: FlexID?
    let problem_id: String?
    let topic: String?
    let user_answer: String?
    let correct: Bool
    let hint_count: Int?
    let duration_ms: Int?
    let error_type: String?
    let created_at: Double?

    /// 后端直接吐 SQLite 原值：`correct` 是 0/1 而不是 true/false，
    /// 主键也可能是 UUID 字符串 —— 逐字段容错，避免一处漂移让整页空白。
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(FlexID.self, forKey: .id)
        session_id = try c.decodeIfPresent(String.self, forKey: .session_id)
        turn_id = try c.decodeIfPresent(FlexID.self, forKey: .turn_id)
        problem_id = try c.decodeIfPresent(String.self, forKey: .problem_id)
        topic = try c.decodeIfPresent(String.self, forKey: .topic)
        user_answer = try c.decodeIfPresent(String.self, forKey: .user_answer)
        correct = try c.decodeFlexBool(forKey: .correct)
        hint_count = try c.decodeIfPresent(Int.self, forKey: .hint_count)
        duration_ms = try c.decodeIfPresent(Int.self, forKey: .duration_ms)
        error_type = try c.decodeIfPresent(String.self, forKey: .error_type)
        created_at = try c.decodeIfPresent(Double.self, forKey: .created_at)
    }
}

extension KeyedDecodingContainer {
    /// 同时接受 true/false、0/1、"1"/"true"
    func decodeFlexBool(forKey key: Key) throws -> Bool {
        if let b = try? decode(Bool.self, forKey: key) { return b }
        if let i = try? decode(Int.self, forKey: key) { return i != 0 }
        if let d = try? decode(Double.self, forKey: key) { return d != 0 }
        if let s = try? decode(String.self, forKey: key) {
            return s == "1" || s.lowercased() == "true"
        }
        throw DecodingError.typeMismatch(
            Bool.self,
            .init(codingPath: codingPath + [key], debugDescription: "期望 bool / 0-1 / 字符串"))
    }

    func decodeFlexBoolIfPresent(forKey key: Key) throws -> Bool? {
        guard contains(key), try !decodeNil(forKey: key) else { return nil }
        return try decodeFlexBool(forKey: key)
    }
}
struct StudentProfile: Codable, Hashable {
    let student_id: String?
    let level: String?
    let independence: String?
    let error_patterns: JSONValue?
    let preferences: JSONValue?
    let narrative: String?
    let updated_at: Double?
}
struct MemoryFact: Codable, Hashable, Identifiable {
    let id: String
    let kind: String?
    let content: String?
    let source_turn: Int?
    let created_at: Double?
}
struct DailyAccuracyRow: Codable, Hashable, Identifiable {
    var id: String { day }
    let day: String
    let total: Int
    let correct: Int
    let rate: Int
}
struct ScratchUsage: Codable, Hashable {
    let turns_total: Int?
    let turns_with_scratch: Int?
    let turns_recognized: Int?
    let scratch_turn_ratio: Double?
    let attempts_total: Int?
    let attempts_with_scratch: Int?
    let attempts_without_scratch: Int?
    let accuracy_with_scratch: Double?
    let accuracy_without_scratch: Double?
}
struct MemoryOverview: Codable {
    let student_id: String
    let generated_at: Double?
    let stats: MemoryStats
    let profile: StudentProfile?
    let mastery: [MasteryRow]
    let attempts: [AttemptRow]
    let facts: [MemoryFact]
    let daily: [DailyAccuracyRow]
    let error_distribution: [TopicCount]?
    let scratch: ScratchUsage?
}
struct AttemptsResp: Codable { let attempts: [AttemptRow] }
struct FactsResp: Codable { let facts: [MemoryFact] }

// MARK: - 评估（管理员）

struct EvalDashboard: Codable {
    struct DimensionAvg: Codable, Identifiable {
        var id: String { dimension }
        let dimension: String
        let avg_value: Double?
        let count: Int?
    }
    struct PromptVersionScore: Codable, Identifiable {
        var id: String { (prompt_version ?? "?") + dimension }
        let dimension: String
        let prompt_version: String?
        let prompt_role: String?
        let avg_value: Double?
        let count: Int?
    }
    struct TokenStats: Codable {
        let total_input_tokens: Int?
        let total_output_tokens: Int?
        let avg_input_tokens: Double?
        let avg_output_tokens: Double?
        let turn_count: Int?
    }
    struct TokenByVersion: Codable, Identifiable {
        var id: String { prompt_version ?? "?" }
        let prompt_version: String?
        let prompt_role: String?
        let total_input_tokens: Int?
        let total_output_tokens: Int?
        let turn_count: Int?
    }
    struct RecentTurn: Codable, Identifiable {
        let id: Int
        let session_id: String?
        let role: String?
        let user_message: String?
        let ai_message: String?
        let tool_calls_json: String?
        let duration_ms: Int?
        let error: String?
        let created_at: Double?
        let input_tokens: Int?
        let output_tokens: Int?
        let prompt_version: String?
        let llm_scores: String?
        let rule_scores: String?
    }
    let total_turns: Int?
    let evaluated_turns: Int?
    let llm_scores: [DimensionAvg]?
    let scores_by_prompt: [PromptVersionScore]?
    let token_stats: TokenStats?
    let tokens_by_prompt: [TokenByVersion]?
    let recent_turns: [RecentTurn]?
}

struct EvalTurnsPage: Codable {
    struct Turn: Codable, Identifiable {
        let id: Int
        let session_id: String?
        let role: String?
        let user_message: String?
        let ai_message: String?
        let duration_ms: Int?
        let error: String?
        let created_at: Double?
        let input_tokens: Int?
        let output_tokens: Int?
        let prompt_version: String?
        let llm_scores: String?
        let rule_scores: String?
    }
    let total: Int
    let page: Int?
    let pageSize: Int?
    let turns: [Turn]
}

struct SessionEvalRow: Codable, Identifiable {
    let id: String
    let role: String?
    let title: String?
    let current_problem_id: String?
    let created_at: Double?
    let updated_at: Double?
    // 评估附加字段（getStudentEvalList / getSessionEvalList）
    let turn_count: Int?
    let student_id: String?
    let username: String?
    let display_name: String?
    let scores: JSONValue?
    let avg_score: Double?
}

// MARK: - Prompt 管理

struct PromptVersion: Codable, Identifiable, Hashable {
    let id: String
    let role: String
    let version: Int?
    let description: String?
    let is_active: Bool?
    let content_length: Int?
    let content_preview: String?
    let content: String?
    let created_at: Double?
}

// MARK: - 运行时配置（管理页）

struct SettingField: Codable, Hashable {
    let value: String?
    let set: Bool?
    let source: String?
}
struct EffectiveSettings: Codable, Hashable {
    struct Module: Codable, Hashable {
        let apiKey: SettingField?
        let baseUrl: SettingField?
        let model: SettingField?
    }
    let common: Module?
    let chat: Module?
    let vision: Module?
    let judge: Module?
}
struct SettingsResp: Codable { let ok: Bool?; let message: String?; let settings: EffectiveSettings? }
struct TestResp: Codable { let ok: Bool?; let message: String?; let latency_ms: Int? }

// MARK: - 账号管理（管理员）

struct UsersResp: Codable {
    struct Totals: Codable { let all: Int; let admins: Int; let students: Int; let parents: Int; let guests: Int }
    let users: [User]
    let totals: Totals?
}
struct AuditRow: Codable, Identifiable {
    let id: Int
    let actor_id: String?
    let actor_username: String?
    let actor_role: String?
    let action: String?
    let target_type: String?
    let target_id: String?
    let detail: String?
    let ip: String?
    let created_at: Double?
}
struct AuditResp: Codable { let logs: [AuditRow] }
struct UserResp: Codable { let user: User?; let children: [Child]?; let stats: ChildStats?; let error: String? }
struct CreatedUserResp: Codable { let ok: Bool?; let user: User?; let error: String? }
struct ResetPwResp: Codable { let ok: Bool?; let generated: Bool?; let password: String?; let error: String? }
struct PurgeResp: Codable { let ok: Bool?; let removed: Int?; let error: String? }

// MARK: - 我的孩子（家长）

struct FamilyChildrenResp: Codable { let children: [Child] }
struct ChildSessionsResp: Codable {
    let student_id: String
    let student: User?
    let sessions: [SessionRow]
}

// MARK: - 通用

struct HealthResp: Codable { let ok: Bool?; let status: String? }
struct LogsResp: Codable { let logs: [String]? }
