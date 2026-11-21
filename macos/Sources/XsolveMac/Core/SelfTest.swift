import Foundation

// MARK: - 接口契约自检
//
// 用途：把客户端用到的每个接口真跑一遍，并按「界面里实际使用的模型」解码，
// 用来验证 Swift 模型与后端 JSON 没有字段/类型漂移。
//
//   swift run XsolveMac --selftest --base http://localhost:8765 --user demo --password demo123
//   swift run XsolveMac --selftest --turn        # 额外跑一次真实 SSE 对话
//
// 无界面、无状态，跑完即退出（0 = 全部通过）。

enum SelfTest {
    static func shouldRun() -> Bool {
        CommandLine.arguments.contains("--selftest")
    }

    private struct Options {
        var base = ProcessInfo.processInfo.environment["XSOLVE_BASE"] ?? "http://localhost:8765"
        var user = ProcessInfo.processInfo.environment["XSOLVE_USER"] ?? "demo"
        var password = ProcessInfo.processInfo.environment["XSOLVE_PASSWORD"] ?? "demo123"
        var withTurn = false
    }

    private static func options() -> Options {
        var o = Options()
        let a = CommandLine.arguments
        for (i, v) in a.enumerated() {
            func next() -> String? { i + 1 < a.count ? a[i + 1] : nil }
            switch v {
            case "--base": if let n = next() { o.base = n }
            case "--user": if let n = next() { o.user = n }
            case "--password": if let n = next() { o.password = n }
            case "--turn": o.withTurn = true
            default: break
            }
        }
        return o
    }

    static func runAndExit() -> Never {
        let opt = options()
        let sem = DispatchSemaphore(value: 0)
        Task {
            var failed = 0
            let results = await check(opt)
            for (name, err) in results {
                if let err {
                    failed += 1
                    print("  ✗ \(name)\n      \(err)")
                } else {
                    print("  ✓ \(name)")
                }
            }
            print("\n\(results.count - failed)/\(results.count) 通过\(failed == 0 ? "" : "，\(failed) 项失败")")
            sem.signal()
            exit(failed == 0 ? 0 : 1)
        }
        sem.wait()
        exit(1)
    }

    private static func check(_ opt: Options) async -> [(String, String?)] {
        let api = APIClient.shared
        api.baseURL = opt.base
        var out: [(String, String?)] = []

        func step(_ name: String, _ body: () async throws -> Void) async {
            do {
                try await body()
                out.append((name, nil))
            } catch {
                out.append((name, (error as? LocalizedError)?.errorDescription ?? "\(error)"))
            }
        }

        print("==> 目标服务器 \(opt.base)")
        var user: User?
        await step("POST api/auth/login") {
            user = try await api.login(username: opt.user, password: opt.password)
        }
        guard let user else {
            print("登录失败，后续检查跳过")
            return out
        }
        print("    已登录：\(user.username)（\(user.role)\(user.is_admin == true ? "，管理员" : "")）")

        var problems: [Problem] = []
        await step("GET  api/problems") {
            problems = try await api.request("GET", "api/problems", body: nil as [String: String]?)
        }
        print("    题库题目数：\(problems.count)")

        var session: SessionInfo?
        await step("POST api/session") {
            session = try await api.request("POST", "api/session", body: Empty())
        }

        if let sid = session?.id {
            await step("GET  api/session/:id") {
                _ = try await api.request("GET", "api/session/\(sid)", body: nil as [String: String]?) as SessionInfo
            }
            await step("GET  api/session/:id/history") {
                _ = try await api.request("GET", "api/session/\(sid)/history", body: nil as [String: String]?) as HistoryResp
            }
            await step("PATCH api/session/:id") {
                _ = try await api.requestOK("PATCH", "api/session/\(sid)", body: ["currentProblemId": problems.first?.id ?? ""])
            }
            await step("POST api/session/:id/scratch-image") {
                _ = try await api.requestOK("POST", "api/session/\(sid)/scratch-image",
                                            body: ["image": AnyEncodable(nil as String?), "strokes": AnyEncodable(0)])
            }
        }

        var items: [WrongItem] = []
        await step("GET  api/wrong-book/books") {
            _ = try await api.request("GET", "api/wrong-book/books", body: nil as [String: String]?) as BooksResp
        }
        await step("GET  api/wrong-book/items") {
            let r: ItemsResp = try await api.request("GET", "api/wrong-book/items", body: nil as [String: String]?)
            items = r.items
        }
        await step("GET  api/wrong-book/due") {
            _ = try await api.request("GET", "api/wrong-book/due", body: nil as [String: String]?) as DueSummary
        }
        await step("GET  api/wrong-book/candidates") {
            _ = try await api.request("GET", "api/wrong-book/candidates", body: nil as [String: String]?) as CandidatesResp
        }
        if let first = items.first {
            await step("GET  api/wrong-book/items/:id") {
                _ = try await api.request("GET", "api/wrong-book/items/\(first.id)", body: nil as [String: String]?) as ItemDetailResp
            }
        }

        await step("GET  api/memory/overview") {
            _ = try await api.request("GET", "api/memory/overview", body: nil as [String: String]?) as MemoryOverview
        }

        if user.is_admin == true {
            await step("GET  api/eval/dashboard") {
                _ = try await api.request("GET", "api/eval/dashboard", query: ["role": "all"], body: nil as [String: String]?) as EvalDashboard
            }
            await step("GET  api/eval/turns") {
                _ = try await api.request("GET", "api/eval/turns", query: ["role": "all", "page": "1"],
                                          body: nil as [String: String]?) as EvalTurnsPage
            }
            await step("GET  api/eval/sessions") {
                _ = try await api.request("GET", "api/eval/sessions", query: ["role": "all"],
                                          body: nil as [String: String]?) as [SessionEvalRow]
            }
            await step("GET  api/eval/student/sessions") {
                _ = try await api.request("GET", "api/eval/student/sessions", query: ["role": "all"],
                                          body: nil as [String: String]?) as [SessionEvalRow]
            }
            var promptList: [PromptVersion] = []
            await step("GET  api/prompts") {
                promptList = try await api.request("GET", "api/prompts", body: nil as [String: String]?)
            }
            if let first = promptList.first {
                await step("GET  api/prompts/:id") {
                    _ = try await api.request("GET", "api/prompts/\(first.id)", body: nil as [String: String]?) as PromptVersion
                }
            }
            await step("GET  api/prompts/roles/list") {
                _ = try await api.request("GET", "api/prompts/roles/list", body: nil as [String: String]?) as [String]
            }
            await step("GET  api/settings") {
                _ = try await api.request("GET", "api/settings", body: nil as [String: String]?) as EffectiveSettings
            }
            await step("GET  api/admin/users") {
                _ = try await api.request("GET", "api/admin/users", body: nil as [String: String]?) as UsersResp
            }
            await step("GET  api/admin/audit") {
                _ = try await api.request("GET", "api/admin/audit", body: nil as [String: String]?) as AuditResp
            }
        } else {
            await step("GET  api/family/children") {
                _ = try await api.request("GET", "api/family/children", body: nil as [String: String]?) as FamilyChildrenResp
            }
        }

        if opt.withTurn, let sid = session?.id {
            await step("POST api/session/:id/turn（SSE 全链路）") {
                var events = 0
                var sawResult = false
                let stream = api.streamTurn(sessionId: sid, message: "1+1 等于几？只回答数字，不要调用工具。",
                                           currentProblemId: problems.first?.id, scratchStrokes: 0)
                for try await ev in stream {
                    events += 1
                    if ev.event == "result" || ev.event == "done" { sawResult = true }
                    if events > 4000 { break }
                }
                if !sawResult { throw APIError.decode("SSE 未收到结束事件（events=\(events)）") }
                print("    SSE 事件数：\(events)")
            }
        }

        _ = try? await api.requestOK("POST", "api/auth/logout", body: Empty())
        return out
    }
}
