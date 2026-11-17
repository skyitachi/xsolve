import Foundation

// MARK: - 回归探针：后端 ui_event → 原生弹窗数据
//
// 用法：`swift run XsolveMac --uievent`（结果写 /tmp/xsolve-uievent.log，跑完自动退出）
//
// 背景：用户报「AI 把题出好了、还提示去弹窗里确认，但窗口里根本没有弹窗」，后端日志里
// `problem_proposed` 明明发出去了。根因是解码口径不对：后端 payload 是
//   { "type": "problem_proposed", "problem": { id, topic, text, ... } }
// 而原生把**整个事件**当 ProposedProblem 解 —— 顶层没有 id → 解码失败 → `try?`
// 静默吞掉 → 弹窗状态永远是 nil。Web 端一直是对的（chat.js 读 `ev.problem`）。
//
// 这里用后端真实 payload 断言：两层结构的 `problem` 能解出来、字段完整、
// 缺字段时不崩也不假装成功。

enum UiEventProbe {
    static var active: Bool { CommandLine.arguments.contains("--uievent") }

    private static let logURL = URL(fileURLWithPath: "/tmp/xsolve-uievent.log")

    private static func log(_ s: String) {
        let line = s + "\n"
        if let h = try? FileHandle(forWritingTo: logURL) {
            h.seekToEndOfFile()
            h.write(Data(line.utf8))
            try? h.close()
        } else {
            try? line.write(to: logURL, atomically: true, encoding: .utf8)
        }
    }

    private static var failures = 0
    private static func check(_ name: String, _ ok: Bool, _ detail: String) {
        if ok { log("  ✓ \(name) — \(detail)") }
        else { failures += 1; log("  ✗ \(name) — \(detail)") }
    }

    /// 与 `backend/mcp-tools.js` 的 propose_problem 逐字段对齐
    private static let proposedEvent = """
    {"type":"problem_proposed","problem":{"id":"ai_1794927911800_21d641",
    "topic":"几何-三角形面积（共边比例）",
    "text":"如图，在 $\\\\triangle ABC$ 中，$BD=DE=EC$，点 $F$ 在 $AE$ 上。",
    "answer":"$\\\\frac{1}{12}$","hints":["先看共边比例","再算面积比"],
    "figure":{"type":"image"},
    "figureImage":"data:image/jpeg;base64,AAAA",
    "proposed":true,"source":"ai"}}
    """

    /// delete_problem 的 payload 多一个 `preview`、没有 answer/hints
    private static let deleteEvent = """
    {"type":"delete_proposed","problem":{"id":"p1","topic":"行程",
    "text":"甲、乙两人从相距 $400$ 千米的两地出发……","preview":"甲、乙两人从相距 400 千米"}}
    """

    @MainActor
    static func runAndExit() {
        try? FileManager.default.removeItem(at: logURL)
        log("== ui_event → 弹窗数据 ==")

        // 1) 出题提议：真实两层结构
        let s1 = TutorState()
        s1.handleUiEvent(Data(proposedEvent.utf8))
        let p = s1.proposal
        check("problem_proposed 弹窗状态被设置", p != nil,
              p == nil ? "proposal = nil（弹窗不会出现）" : "proposal.id = \(p!.id)")
        check("id 正确", p?.id == "ai_1794927911800_21d641", "id = \(p?.id ?? "nil")")
        check("topic 正确", p?.topic == "几何-三角形面积（共边比例）", "topic = \(p?.topic ?? "nil")")
        check("text 里的 LaTeX 没被吃掉", p?.text?.contains("\\triangle ABC") == true,
              "text 片段 = \(String((p?.text ?? "").prefix(28)))…")
        check("answer 解出来了", p?.answer == "$\\frac{1}{12}$", "answer = \(p?.answer ?? "nil")")
        check("hints 解出来了", p?.hints?.count == 2, "hints = \(p?.hints?.count ?? -1) 条")
        check("figure.type = image（原图作插图）", p?.figure?.type == "image",
              "figure = \(p?.figure?.type ?? "nil")")
        check("figureImage 透传（弹窗要预览原图）",
              p?.figureImage?.hasPrefix("data:image/jpeg") == true,
              "figureImage = \(p?.figureImage?.prefix(22) ?? "nil")…")

        // 2) 删除确认：字段比出题少，不能因为缺 answer/hints 就整个解不出来
        let s2 = TutorState()
        s2.handleUiEvent(Data(deleteEvent.utf8))
        check("delete_proposed 弹窗状态被设置",
              s2.deleteProposal?.problem.id == "p1",
              "deleteProposal = \(s2.deleteProposal?.problem.id ?? "nil")")
        check("删除提示按 AI 发起", s2.deleteProposal?.fromAI == true,
              "fromAI = \(s2.deleteProposal?.fromAI ?? false)")

        // 3) 旧写法（整包当题目）必须解不出来 —— 这就是之前弹窗不出现的机理，
        //    留一条断言防止以后又改回去
        let whole = try? JSONDecoder().decode([String: JSONValue].self, from: Data(proposedEvent.utf8))
        let wrong = whole.flatMap {
            try? JSONDecoder().decode(ProposedProblem.self,
                                      from: try JSONEncoder().encode($0))
        }
        check("整包当题目解码（旧写法）确实会失败", wrong == nil,
              "整包解码结果 = \(wrong == nil ? "nil（证明是这个坑）" : "居然成功了")")

        // 4) 缺 problem 字段：不崩、不假装成功，且给出可见提示
        let s3 = TutorState()
        s3.handleUiEvent(Data("{\"type\":\"problem_proposed\"}".utf8))
        let warned = s3.entries.contains { entry in
            if case .system(let t) = entry.kind { return t.contains("解析失败") }
            return false
        }
        check("缺字段时不静默（有可见提示）", s3.proposal == nil && warned,
              "proposal = nil, 提示 = \(warned ? "有" : "无")")

        // 5) 乱七八糟的数据不能崩
        let s4 = TutorState()
        s4.handleUiEvent(Data("not json".utf8))
        s4.handleUiEvent(Data("[]".utf8))
        check("坏数据不崩、不改状态", s4.proposal == nil && s4.deleteProposal == nil,
              "proposal/deleteProposal 都为 nil")

        // 6) 点「替换并开始做这题」时没有会话 id：必须关窗 + 明确报错，
        //    不能用 `try?` 吞掉（弹窗照关、题没换，用户只看到「点了没反应」）
        let s5 = TutorState()
        s5.handleUiEvent(Data(proposedEvent.utf8))
        let hadProposal = s5.proposal != nil
        let flag = Flag()
        Task { @MainActor in
            await s5.acceptProposal()
            flag.done = true
        }
        var waited = 0.0
        while !flag.done && waited < 3 {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            waited += 0.05
        }
        let cleanWarned = s5.entries.contains { entry in
            if case .error(let t) = entry.kind { return t.contains("换题失败") }
            return false
        }
        check("没有会话时确认换题：关窗且明确报错",
              hadProposal && s5.proposal == nil && cleanWarned,
              "提案存在过=\(hadProposal), 弹窗已关=\(s5.proposal == nil), 报错提示=\(cleanWarned)")

        log(failures == 0 ? "\n全部通过" : "\n\(failures) 项失败")
        exit(failures == 0 ? 0 : 1)
    }
}

/// Task 与 RunLoop 之间传信号用（探针串行跑，不需要更复杂的同步）
final class Flag {
    var done = false
}
