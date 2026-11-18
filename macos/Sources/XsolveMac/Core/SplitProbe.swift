import AppKit
import SwiftUI

// MARK: - 回归探针：两栏分隔条能不能拖动
//
// 用法：`swift run XsolveMac --uisplit`（结果写 /tmp/xsolve-split.log，跑完退出）
//
// 背景：原来用 `HSplitView`，两个子视图都带 `.frame(minWidth:idealWidth:maxWidth:)`，
// 每次布局都用 idealWidth 重算 → 拖动改的值立刻被覆盖，用户看到的是「分隔条拖不动」。
// 现在换成自算的 SplitPane（左栏宽度是显式数值、写进 @AppStorage）。
//
// 验证方式：左红右蓝渲染到位图里，扫中线第一列「非红」像素 = 分隔位置；
// 再直接调分隔条视图的 mouseDown/Dragged/Up，看它会不会跟着走。

enum SplitProbe {
    static var active: Bool { CommandLine.arguments.contains("--uisplit") }

    private static let logURL = URL(fileURLWithPath: "/tmp/xsolve-split.log")
    private static var failures = 0

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

    private static func check(_ name: String, _ ok: Bool, _ detail: String) {
        if ok {
            log("  ✓ \(name) — \(detail)")
        } else {
            failures += 1
            log("  ✗ \(name) — \(detail)")
        }
    }

    private static func spin(_ seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    }

    private static func fmt(_ v: CGFloat?) -> String {
        guard let v else { return "无" }
        return String(format: "%.0f", v)
    }

    @MainActor
    static func runAndExit() -> Never {
        _ = NSApplication.shared
        log("==> 两栏分隔条探针（拖动 / 夹紧 / 复位）")

        let winWidth: CGFloat = 1200
        let winHeight: CGFloat = 600
        let minLeft: CGFloat = 300
        let minRight: CGFloat = 380
        let handleWidth: CGFloat = 9
        let startWidth: CGFloat = 560
        let store = Store()

        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: winWidth, height: winHeight),
                           styleMask: [.titled], backing: .buffered, defer: false)
        win.contentView = NSHostingView(rootView: Host(store: store,
                                                      minLeft: minLeft,
                                                      minRight: minRight,
                                                      startWidth: startWidth))
        win.setFrameOrigin(NSPoint(x: 60, y: 60))
        win.orderFrontRegardless()
        spin(0.6)

        var b = boundary(win)
        log("  · 初始 leftWidth=560 → 分隔线 x=\(fmt(b))")
        check("初始位置跟随存储值", abs((b ?? -1) - startWidth) <= 3, "x=\(fmt(b))")

        // 太窄 → minLeft
        store.value = 100
        spin(0.25)
        b = boundary(win)
        check("左栏不窄于 minLeft", abs((b ?? -1) - minLeft) <= 3, "x=\(fmt(b)) 期望 \(fmt(minLeft))")

        // 太宽 → 给右栏留够
        store.value = 5000
        spin(0.25)
        b = boundary(win)
        let maxLeft: CGFloat = winWidth - minRight - handleWidth
        check("左栏不挤占右栏最小宽度", abs((b ?? -1) - maxLeft) <= 3,
              "x=\(fmt(b)) 期望 \(fmt(maxLeft))")

        // 真拖动 +180
        store.value = startWidth
        spin(0.25)
        let handleX: CGFloat = startWidth + handleWidth / 2
        let dragged = drag(win, fromX: handleX, toX: handleX + 180, height: winHeight)
        spin(0.3)
        b = boundary(win)
        log("  · 拖动 +180 → leftWidth=\(fmt(store.value)) 分隔线 x=\(fmt(b))（派发=\(dragged)）")
        check("拖动能改宽度", abs(store.value - (startWidth + 180)) <= 6,
              "leftWidth=\(fmt(store.value)) 期望 \(fmt(startWidth + 180))")
        check("画面跟着动了", abs((b ?? -1) - (startWidth + 180)) <= 6, "x=\(fmt(b))")

        // 往左拖到越界
        drag(win, fromX: 740 + handleWidth / 2, toX: 100, height: winHeight)
        spin(0.3)
        check("拖到左边被 minLeft 挡住", abs(store.value - minLeft) <= 6,
              "leftWidth=\(fmt(store.value))")

        // 双击复位
        store.value = 900
        spin(0.25)
        doubleClick(win, atX: 900 + handleWidth / 2, height: winHeight)
        spin(0.3)
        check("双击复位到默认宽度", abs(store.value - startWidth) <= 6,
              "leftWidth=\(fmt(store.value))")

        // 窗口变窄
        win.setContentSize(NSSize(width: 900, height: winHeight))
        store.value = 700
        spin(0.5)
        b = boundary(win)
        check("窗口变窄后仍给右栏留够宽度", (b ?? 9999) <= 900 - minRight + 3,
              "x=\(fmt(b)) ≤ \(fmt(900 - minRight))")

        win.close()
        log(failures == 0 ? "==> 全部通过" : "==> 失败 \(failures) 项")
        exit(failures == 0 ? 0 : 1)
    }

    /// 探针里代替 @AppStorage 的可观察存储
    final class Store: ObservableObject {
        @Published var value: CGFloat = 560
    }

    private struct Host: View {
        @ObservedObject var store: Store
        let minLeft: CGFloat
        let minRight: CGFloat
        let startWidth: CGFloat

        var body: some View {
            SplitPane(leftWidth: $store.value,
                      minLeft: minLeft,
                      minRight: minRight,
                      defaultWidth: startWidth) {
                Color(.sRGB, red: 1, green: 0, blue: 0, opacity: 1)
            } right: {
                Color(.sRGB, red: 0, green: 0, blue: 1, opacity: 1)
            }
        }
    }

    /// 扫中线第一列「不是纯红」的像素 = 分隔条位置（pt）
    private static func boundary(_ win: NSWindow) -> CGFloat? {
        guard let view = win.contentView else { return nil }
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        let scale: CGFloat = max(1, CGFloat(rep.pixelsWide) / max(1, view.bounds.width))
        let y: Int = rep.pixelsHigh / 2
        for x in 0..<rep.pixelsWide {
            guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
            let isRed: Bool = c.redComponent > 0.75 && c.greenComponent < 0.35 && c.blueComponent < 0.35
            if !isRed { return CGFloat(x) / scale }
        }
        return nil
    }

    private static func event(_ type: NSEvent.EventType, _ win: NSWindow,
                              _ p: NSPoint, clicks: Int = 1) -> NSEvent? {
        let pressure: Float = type == .leftMouseUp ? 0 : 1
        return NSEvent.mouseEvent(with: type, location: p, modifierFlags: [],
                                  timestamp: ProcessInfo.processInfo.systemUptime,
                                  windowNumber: win.windowNumber, context: nil, eventNumber: 0,
                                  clickCount: clicks, pressure: pressure)
    }

    /// 直接派给 AppKit 的分隔条视图（down → 若干 drag → up）。
    /// ⚠️ 不能走 `win.sendEvent`：探针进程不是活跃 App（isKeyWindow == false），
    /// NSWindow 会把鼠标事件当「非活跃窗口的点击」丢掉；也不能指望 SwiftUI 的 DragGesture
    /// 认合成事件。分隔条是 NSView，直接调它的 mouseDown/Dragged/Up 就能走完整条链路。
    @discardableResult
    private static func drag(_ win: NSWindow, fromX: CGFloat, toX: CGFloat, height: CGFloat) -> Bool {
        guard let handle = findHandle(win.contentView) else { return false }
        let y: CGFloat = height / 2
        guard let down = event(.leftMouseDown, win, NSPoint(x: fromX, y: y)) else { return false }
        handle.mouseDown(with: down)
        let steps: Int = 6
        for i in 1...steps {
            let t: CGFloat = CGFloat(i) / CGFloat(steps)
            let x: CGFloat = fromX + (toX - fromX) * t
            if let d = event(.leftMouseDragged, win, NSPoint(x: x, y: y)) {
                handle.mouseDragged(with: d)
            }
            spin(0.02)
        }
        if let up = event(.leftMouseUp, win, NSPoint(x: toX, y: y)) {
            handle.mouseUp(with: up)
        }
        return true
    }

    private static func doubleClick(_ win: NSWindow, atX x: CGFloat, height: CGFloat) {
        guard let handle = findHandle(win.contentView) else { return }
        let y: CGFloat = height / 2
        for clicks in [1, 2] {
            if let d = event(.leftMouseDown, win, NSPoint(x: x, y: y), clicks: clicks) {
                handle.mouseDown(with: d)
            }
            if let u = event(.leftMouseUp, win, NSPoint(x: x, y: y), clicks: clicks) {
                handle.mouseUp(with: u)
            }
            spin(0.05)
        }
    }

    /// 在视图树里找那个 AppKit 分隔条
    private static func findHandle(_ v: NSView?) -> SplitHandleView? {
        guard let v else { return nil }
        if let h = v as? SplitHandleView { return h }
        for sub in v.subviews {
            if let h = findHandle(sub) { return h }
        }
        return nil
    }
}
