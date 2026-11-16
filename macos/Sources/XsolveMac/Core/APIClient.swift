import Foundation

// MARK: - 错误

enum APIError: LocalizedError {
    case badURL
    case http(Int, String)          // status + server error message
    case network(String)
    case decode(String)

    var errorDescription: String? {
        switch self {
        case .badURL: return "服务器地址不正确"
        case .http(let code, let msg): return "HTTP \(code)：\(msg)"
        case .network(let msg): return "网络错误：\(msg)"
        case .decode(let msg): return "数据解析失败：\(msg)"
        }
    }
}

// MARK: - 自签名证书容许（局域网 HTTPS 用）

final class PermissiveTrustDelegate: NSObject, URLSessionDelegate {
    static let shared = PermissiveTrustDelegate()
    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

// MARK: - SSE 事件

struct SSEEvent {
    let event: String
    let data: Data
}

// MARK: - APIClient

final class APIClient: ObservableObject {
    static let shared = APIClient()

    /// 后端根地址（如 http://localhost:8765）。登录页可改，存 UserDefaults。
    @Published var baseURL: String {
        didSet { UserDefaults.standard.set(baseURL, forKey: "xsolve_server") }
    }

    /// 允许自签名证书（局域网 HTTPS / NAS 部署时打开）
    @Published var allowSelfSigned: Bool {
        didSet { UserDefaults.standard.set(allowSelfSigned, forKey: "xsolve_allow_self_signed") }
    }

    private lazy var cookieSession: URLSession = makeSession()
    private lazy var trustSession: URLSession = makeSession(delegate: PermissiveTrustDelegate.shared)

    private func makeSession(delegate: URLSessionDelegate? = nil) -> URLSession {
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = .shared
        cfg.httpShouldSetCookies = true
        cfg.timeoutIntervalForRequest = 300      // SSE turn 可能很长（视觉识别 + 多轮工具）
        cfg.timeoutIntervalForResource = 3600
        return URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)
    }

    init() {
        self.baseURL = UserDefaults.standard.string(forKey: "xsolve_server") ?? "http://localhost:8765"
        self.allowSelfSigned = UserDefaults.standard.bool(forKey: "xsolve_allow_self_signed")
    }

    // MARK: URL 构造

    func url(_ path: String, query: [String: String]? = nil) throws -> URL {
        var s = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        guard var comps = URLComponents(string: s.isEmpty ? "http://localhost:8765" : s) else { throw APIError.badURL }
        // URLComponents 的 path 必须以 "/" 开头，否则 url 为 nil（曾导致所有请求报「服务器地址不正确」）
        var basePath = comps.path
        if !basePath.hasPrefix("/") { basePath = "/" + basePath }
        let clean = path.hasPrefix("/") ? String(path.dropFirst()) : path
        comps.path = (basePath as NSString).appendingPathComponent(clean)
        if let query, !query.isEmpty {
            comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let u = comps.url else { throw APIError.badURL }
        return u
    }

    private var session: URLSession { allowSelfSigned ? trustSession : cookieSession }

    // MARK: 通用 JSON 请求

    func request<T: Decodable>(_ method: String, _ path: String,
                               query: [String: String]? = nil,
                               body: Encodable? = nil) async throws -> T {
        let (data, resp) = try await raw(method, path, query: query, body: body)
        let decoder = JSONDecoder()
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            // 有些接口成功时回 {ok:true,...}，失败时回 {error}；都解不出时给出原文
            if let err = try? decoder.decode(SimpleOK.self, from: data), let msg = err.error {
                throw APIError.http((resp as? HTTPURLResponse)?.statusCode ?? 500, msg)
            }
            let raw = String(data: data.prefix(300), encoding: .utf8) ?? ""
            // 把 DecodingError 的 codingPath 带出来：只看 300 字 JSON 原文，
            // 嵌套数组里究竟哪个字段对不上根本定位不到（这次就卡在这里）。
            var detail = "\(error)"
            if let e = error as? DecodingError {
                switch e {
                case .keyNotFound(let key, let ctx):
                    detail = "缺少字段 " + (ctx.codingPath + [key]).map(\.stringValue).joined(separator: ".")
                case .typeMismatch(let type, let ctx):
                    detail = "字段 " + ctx.codingPath.map(\.stringValue).joined(separator: ".")
                        + " 类型不匹配（期望 \(type)）：\(ctx.debugDescription)"
                case .valueNotFound(let type, let ctx):
                    detail = "字段 " + ctx.codingPath.map(\.stringValue).joined(separator: ".")
                        + " 为 null（期望 \(type)）"
                case .dataCorrupted(let ctx):
                    detail = "字段 " + ctx.codingPath.map(\.stringValue).joined(separator: ".")
                        + "：\(ctx.debugDescription)"
                default:
                    break
                }
            }
            throw APIError.decode(detail + "\n原文：" + raw)
        }
    }

    @discardableResult
    func requestOK(_ method: String, _ path: String,
                   query: [String: String]? = nil,
                   body: Encodable? = nil) async throws -> [String: JSONValue] {
        let (data, _) = try await raw(method, path, query: query, body: body)
        guard let obj = try? JSONDecoder().decode([String: JSONValue].self, from: data) else {
            throw APIError.decode(String(data: data.prefix(300), encoding: .utf8) ?? "bad json")
        }
        return obj
    }

    func raw(_ method: String, _ path: String,
             query: [String: String]? = nil,
             body: Encodable? = nil) async throws -> (Data, URLResponse) {
        var req = URLRequest(url: try url(path, query: query))
        req.httpMethod = method
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        do {
            let (data, resp) = try await session.data(for: req)
            try checkHTTP(resp, data: data)
            return (data, resp)
        } catch let e as APIError {
            throw e
        } catch {
            throw APIError.network(error.localizedDescription)
        }
    }

    private func checkHTTP(_ resp: URLResponse, data: Data) throws {
        guard let http = resp as? HTTPURLResponse else { return }
        guard !(200...299).contains(http.statusCode) else { return }
        var msg = ""
        if let obj = try? JSONDecoder().decode([String: JSONValue].self, from: data),
           let e = obj["error"]?.stringValue {
            msg = e
        } else if let t = String(data: data.prefix(200), encoding: .utf8) {
            msg = t
        }
        throw APIError.http(http.statusCode, msg)
    }

    // MARK: SSE 流（POST /api/session/:id/turn）

    /// 发起 turn 请求并以 AsyncStream 逐条产出 SSE 事件；Task 取消即断流（等价浏览器 AbortController）。
    func streamTurn(sessionId: String,
                    message: String,
                    image: (mediaType: String, data: String)? = nil,
                    audio: (mediaType: String, data: String)? = nil,
                    currentProblemId: String?,
                    scratchStrokes: Int) -> AsyncThrowingStream<SSEEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = URLRequest(url: try url("api/session/\(sessionId)/turn"))
                    req.httpMethod = "POST"
                    req.setValue("application/json", forHTTPHeaderField: "content-type")
                    let body: [String: Any?] = [
                        "message": message,
                        "image": image.map { ["mediaType": $0.mediaType, "data": $0.data] },
                        "audio": audio.map { ["mediaType": $0.mediaType, "data": $0.data] },
                        "currentProblemId": currentProblemId,
                        "scratchStrokes": scratchStrokes,
                    ]
                    req.httpBody = try JSONSerialization.data(withJSONObject: body.mapValues { $0 ?? NSNull() })

                    let (bytes, resp) = try await self.session.bytes(for: req)
                    try self.checkHTTP(resp, data: Data())
                    let debug = ProcessInfo.processInfo.environment["XSOLVE_DEBUG_SSE"] != nil
                    if debug {
                        let http = resp as? HTTPURLResponse
                        FileHandle.standardError.write(Data("[sse] status=\(http?.statusCode ?? -1) type=\(http?.value(forHTTPHeaderField: "content-type") ?? "-")\n".utf8))
                    }
                    // ⚠️ 按字节扫描 "\n\n" 分帧：URLSession 的 `bytes.lines` 不产出空行，
                    // 用它拼不回分隔符（曾导致 SSE 一条事件都收不到，静默 0 事件）。
                    var buf = [UInt8]()
                    var iter = bytes.makeAsyncIterator()
                    while let b = try await iter.next() {
                        if Task.isCancelled { break }
                        buf.append(b)
                        if buf.count >= 2, buf[buf.count - 1] == 0x0A, buf[buf.count - 2] == 0x0A {
                            let chunk = String(decoding: buf.dropLast(2), as: UTF8.self)
                            buf.removeAll(keepingCapacity: true)
                            if let ev = Self.parseChunk(chunk) {
                                if debug { FileHandle.standardError.write(Data("[sse] ev=\(ev.event)\n".utf8)) }
                                continuation.yield(ev)
                            }
                        }
                    }
                    // 流末尾可能没有空行收尾
                    if !buf.isEmpty, let ev = Self.parseChunk(String(decoding: buf, as: UTF8.self)) {
                        continuation.yield(ev)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// 解析一个 SSE chunk（多行，含 event: 与 data:）
    static func parseChunk(_ chunk: String) -> SSEEvent? {
        var event = "message"
        var data = ""
        for line in chunk.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("event:") {
                event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                data += String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            }
        }
        guard !data.isEmpty else { return nil }
        return SSEEvent(event: event, data: Data(data.utf8))
    }

    // MARK: - 认证

    func login(username: String, password: String) async throws -> User {
        let r: LoginResp = try await request("POST", "api/auth/login", body: ["username": username, "password": password])
        return r.user
    }

    func register(username: String, password: String, role: String, displayName: String?, inviteCode: String?) async throws -> User {
        let r: LoginResp = try await request("POST", "api/auth/register", body: [
            "username": username, "password": password, "role": role,
            "display_name": displayName ?? "", "invite_code": inviteCode ?? "",
        ])
        return r.user
    }

    func guestLogin() async throws -> User {
        let r: LoginResp = try await request("POST", "api/auth/guest", body: Empty())
        return r.user
    }

    func me() async throws -> User {
        let r: LoginResp = try await request("GET", "api/auth/me", body: nil as [String: String]?)
        return r.user
    }

    func logout() async {
        _ = try? await requestOK("POST", "api/auth/logout", body: Empty())
        HTTPCookieStorage.shared.removeCookies(since: .distantPast)
    }

    func changePassword(old: String, new: String) async throws -> String {
        let r: SimpleOK = try await request("POST", "api/auth/password", body: ["old_password": old, "new_password": new])
        if let e = r.error { throw APIError.http(400, e) }
        return r.note ?? "已修改"
    }

    func health() async throws -> Bool {
        let r: HealthResp = try await request("GET", "api/health", body: nil as [String: String]?)
        return r.ok ?? false
    }
}

// MARK: - AnyEncodable（让 Encodable 参数可以擦除类型）

struct AnyEncodable: Encodable {
    private let encodeFunc: (Encoder) throws -> Void
    init(_ wrapped: Encodable) { encodeFunc = wrapped.encode }
    func encode(to encoder: Encoder) throws { try encodeFunc(encoder) }
}

/// 空对象 {}
struct Empty: Encodable {}
