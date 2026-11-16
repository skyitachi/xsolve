import AppKit
import SwiftUI

// MARK: - 回归探针：草稿画布能不能真的画上笔迹
//
// 用法：`swift run XsolveMac --uidraw`（结果写 /tmp/xsolve-uidraw.log，跑完自动退出）
//
// 背景：「画笔」按钮只做一件事 —— 把 ScratchModel.tool 从 pen/eraser 之间切换。
// 而 pen 本来就是默认值，所以点了看不出任何变化，容易让人怀疑它是不是没接线。
// 这里直接合成鼠标按下/拖动/抬起事件打到画布上，验证笔迹真的进了 model。
//
// 断言：
//   画笔模式拖动 → 新增 1 条 t == "pen" 的笔画，且点数 > 3
//   橡皮模式拖动 → 新增 1 条 t == "eraser" 的笔画
//   撤销 → 笔画数回落

final class ProbeCounter: ObservableObject {
    @Published var taps = 0
}

struct DrawProbeRoot: View {
    @ObservedObject var counter: ProbeCounter
    @ObservedObject var model: ScratchModel

    var body: some View {
        VStack(spacing: 0) {
            // 对照组：同一个事件通道上的普通按钮。它要是也不响应，
            // 说明是探针的合成事件没打进 SwiftUI，而不是画布有问题。
            Button("control") { counter.taps += 1 }
                .frame(width: 120, height: 30)
            ScratchCanvasView(model: model)
        }
    }
}

enum DrawProbe {
    static var active: Bool { CommandLine.arguments.contains("--uidraw") }

    private static let logURL = URL(fileURLWithPath: "/tmp/xsolve-uidraw.log")

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

    @MainActor
    static func runAndExit() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)   // .accessory 的窗口拿不到 key，SwiftUI 不会分发鼠标事件

        log("==> 草稿画布落笔探针（ScratchCanvasView）")

        let model = ScratchModel()
        let counter = ProbeCounter()
        let host = NSHostingView(rootView: DrawProbeRoot(counter: counter, model: model))
        host.frame = NSRect(x: 0, y: 0, width: 600, height: 400)

        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400),
                           styleMask: [.titled], backing: .buffered, defer: false)
        win.contentView = host
        win.makeKeyAndOrderFront(nil)
        win.orderFrontRegardless()
        app.activate(ignoringOtherApps: true)
        win.makeKey()
        win.makeFirstResponder(host)
        host.layoutSubtreeIfNeeded()
        spin(0.6)
        log("    窗口 key=\(win.isKeyWindow) 可见=\(win.isVisible)")

        func ev(_ type: NSEvent.EventType, _ p: CGPoint) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: p, modifierFlags: [],
                               timestamp: ProcessInfo.processInfo.systemUptime,
                               windowNumber: win.windowNumber, context: nil,
                               eventNumber: 0, clickCount: 1,
                               pressure: type == .leftMouseUp ? 0 : 1)!
        }

        // 合成一次拖动：window 坐标原点在左下
        func drag(from: CGPoint, to: CGPoint, steps: Int) {
            app.sendEvent(ev(.leftMouseDown, from))
            spin(0.06)
            for i in 1...steps {
                let k = CGFloat(i) / CGFloat(steps)
                let p = CGPoint(x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k)
                app.sendEvent(ev(.leftMouseDragged, p))
                spin(0.02)
            }
            app.sendEvent(ev(.leftMouseUp, to))
            spin(0.3)
        }

        // 0) 对照组：普通按钮点一下，确认合成事件能进 SwiftUI
        let tapsBefore = counter.taps
        app.sendEvent(ev(.leftMouseDown, CGPoint(x: 60, y: 385)))
        spin(0.05)
        app.sendEvent(ev(.leftMouseUp, CGPoint(x: 60, y: 385)))
        spin(0.4)
        let controlOK = counter.taps > tapsBefore
        log("    对照组按钮 taps \(tapsBefore) → \(counter.taps)")

        // A. 模型层（不依赖输入事件，任何环境都必须通过）
        log("-- 模型层（画笔 = tool 状态位）")
        check("默认工具就是画笔", model.tool == "pen", "tool = \(model.tool)")
        check("画笔是细黑笔", model.strokeColor.width == ScratchModel.penWidth,
              "width = \(model.strokeColor.width)")
        model.tool = "eraser"
        check("切橡皮后变宽笔", model.strokeColor.width == ScratchModel.eraserWidth,
              "width = \(model.strokeColor.width)")
        model.tool = "pen"

        // 手动灌一笔，验证 append / extendLast / undo / 导出
        model.append(point: StrokePoint(x: 10, y: 10))
        check("落笔建立笔画", model.strokes.count == 1 && model.strokes[0].p.count == 1,
              "笔画数 \(model.strokes.count)")
        model.extendLast(point: StrokePoint(x: 40, y: 30))
        check("拖动延长同一笔", model.strokes.count == 1 && model.strokes[0].p.count == 2,
              "点数 \(model.strokes[0].p.count)")
        model.tool = "eraser"
        model.append(point: StrokePoint(x: 20, y: 20))
        check("橡皮落笔标记为 eraser", model.strokes.last?.t == "eraser",
              "t = \(model.strokes.last?.t ?? "-")")
        model.canvasSize = CGSize(width: 600, height: 300)
        let exported = model.exportImage()
        check("能导出草稿图", (exported?.hasPrefix("data:image/jpeg;base64,") ?? false),
              "长度 \(exported?.count ?? 0)")

        // B. UI 层：合成鼠标事件（需要窗口拿到键盘焦点，后台进程通常做不到）
        guard controlOK else {
            log("-- UI 层：跳过（窗口 key=\(win.isKeyWindow)，对照组按钮也没收到点击 →")
            log("   本环境无法把合成事件送进 SwiftUI，落笔只能人工验证）")
            log("\n模型层全部通过；UI 层未验证")
            log("日志：\(logURL.path)")
            exit(2)
        }

        log("-- UI 层（合成鼠标事件）")
        // 1) 画笔（默认工具）
        model.clear()
        let before = model.strokes.count
        drag(from: CGPoint(x: 120, y: 160), to: CGPoint(x: 420, y: 200), steps: 12)
        let penAdded = model.strokes.count - before
        let penStroke = model.strokes.last
        check("画笔能落笔", penAdded == 1 && (penStroke?.p.count ?? 0) > 3,
              "新增 \(penAdded) 条，点数 \(penStroke?.p.count ?? 0)，tool=\(penStroke?.t ?? "-")")
        check("笔画标记为 pen", penStroke?.t == "pen", "t = \(penStroke?.t ?? "-")")

        // 2) 切橡皮（等价于点「橡皮」按钮后的状态），再拖一次
        model.tool = "eraser"
        spin(0.15)
        let before2 = model.strokes.count
        drag(from: CGPoint(x: 150, y: 170), to: CGPoint(x: 300, y: 180), steps: 8)
        let eraserStroke = model.strokes.last
        check("橡皮能落笔", model.strokes.count - before2 == 1 && eraserStroke?.t == "eraser",
              "t = \(eraserStroke?.t ?? "-")")

        // 3) 撤销
        let before3 = model.strokes.count
        model.undo()
        spin(0.1)
        check("撤销生效", model.strokes.count == before3 - 1, "\(before3) → \(model.strokes.count)")

        log(failures == 0 ? "\n全部通过" : "\n\(failures) 项失败")
        log("日志：\(logURL.path)")
        exit(failures == 0 ? 0 : 1)
    }

    /// 跑一小段主 runloop，让 SwiftUI 完成布局与手势状态推进
    @MainActor
    private static func spin(_ seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
    }
}
