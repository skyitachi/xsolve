import SwiftUI
import AppKit

// MARK: - 侧栏拉动探针
//
// 用法：XsolveMac --uibar [--base http://localhost:8765]
// 用真实 MainTabView 起一个窗口，模拟「拖动侧栏分隔条」：
// 优先找 NavigationSplitView 底层的 NSSplitView 直接 setPosition（等价于拖动），
// 每一步同时存 cacheDisplay 位图（布局证据）与 screencapture 真实合成图（材质证据），
// 用来复现用户反馈的「拉动侧栏时出现异常」。

@MainActor
enum BarProbe {
    static var active: Bool { CommandLine.arguments.contains("--uibar") }
    private static let logURL = URL(fileURLWithPath: "/tmp/xsbar/probe.log")
    private static var failures = 0
    private static var winNumber: Int = 0

    private static func log(_ s: String) {
        let line = s + "\n"
        if let h = try? FileHandle(forWritingTo: logURL) {
            h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close()
        } else {
            try? line.write(to: logURL, atomically: true, encoding: .utf8)
        }
    }

    private static func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        if ok { log("✓ \(name)") } else { log("✗ \(name)  \(detail)"); failures += 1 }
    }

    private static func spin(_ s: Double) {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: s))
    }

    static func runAndExit() {
        try? FileManager.default.removeItem(at: logURL)
        try? FileManager.default.createDirectory(atPath: "/tmp/xsbar", withIntermediateDirectories: true)
        log("==> 侧栏拉动探针")

        Task { @MainActor in
            let m = AppModel.shared
            m.bootstrapped = true
            if let i = CommandLine.arguments.firstIndex(of: "--base"), i + 1 < CommandLine.arguments.count {
                APIClient.shared.baseURL = CommandLine.arguments[i + 1]
            }
            log("base=\(APIClient.shared.baseURL)")
            do {
                let u = try await APIClient.shared.login(username: "demo", password: "demo123")
                m.applyLogin(u)
                log("login ok \(u.username)")
            } catch {
                log("login FAILED \(error.localizedDescription)")
            }
            m.bootstrapped = true

            let width: CGFloat = 1080, height: CGFloat = 732
            let root = RootView()
                .environmentObject(AppModel.shared)
                .frame(width: width, height: height)
            let win = NSWindow(contentRect: NSRect(x: 100, y: 100, width: width, height: height),
                               styleMask: [.titled, .closable, .resizable],
                               backing: .buffered, defer: false)
            win.title = "uibar"
            win.contentView = NSHostingView(rootView: root)
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            win.makeKeyAndOrderFront(nil)
            spin(1.5)
            winNumber = win.windowNumber

            guard let host = win.contentView else { log("✗ 无 contentView"); exit(1) }

            // ---- 找 NavigationSplitView 底层的 NSSplitView ----
            let splitViews = findAllSplitViews(host)
            log("底层 NSSplitView 数量 = \(splitViews.count)")
            for (i, sv) in splitViews.enumerated() {
                log("  · sv[\(i)] \(sv.subviews.count) 格 dividerStyle=\(sv.dividerStyle) "
                    + "位置=\(sv.arrangedSubviews.map { Int($0.frame.width) })")
            }

            let e0 = sidebarEdge(host)
            log("初始侧栏边界 x=\(e0.map(String.init) ?? "??")")
            check("初始边界在合理范围", e0.map { $0 > 120 && $0 < 420 } ?? false)
            capture("step0-baseline")

            if let sv = splitViews.first {
                // ---- 约束冲突复现：原详情区 minWidth 900 + 侧栏 216 = 1116 > 窗口 1080。
                // 抖动窗口尺寸强迫布局重排，看侧栏是否掉进「紧凑态」（图标/分组头消失）----
                let paneWidth = { @MainActor in sv.arrangedSubviews.first?.frame.width ?? CGFloat(-1) }
                log("pane 初始=\(Int(paneWidth()))")

                var broken = 0
                for round in 0..<4 {
                    for w in [1040.0, 1080.0, 1000.0, 1080.0] {
                        win.setContentSize(NSSize(width: w, height: 732))
                        spin(0.35)
                    }
                    sv.setPosition(paneWidth() + 40, ofDividerAt: 0)
                    spin(0.4)
                    sv.setPosition(paneWidth() - 40, ofDividerAt: 0)
                    spin(0.4)
                    let ok = sidebarHasIcons(host)
                    log("round\(round): pane=\(Int(paneWidth())) 图标=\(ok ? "有" : "无（紧凑态！）")")
                    if !ok {
                        broken += 1
                        capture("broken-r\(round)")
                    }
                }

                // ---- 全宽度扫描：196..280 每档都验图标 + 分组头 ----
                log("-- 宽度扫描 --")
                for w in [280.0, 260.0, 240.0, 220.0, 200.0, 196.0, 216.0] {
                    sv.setPosition(CGFloat(w), ofDividerAt: 0)
                    spin(0.3)
                    let ok = sidebarHasIcons(host)
                    let pw = sv.arrangedSubviews.first?.frame.width ?? -1
                    log("  w=\(Int(w)) → pane=\(Int(pw)) 图标=\(ok ? "有" : "无")")
                    if !ok {
                        broken += 1
                        capture("compact-\(Int(w))")
                    }
                }
                capture("after-jitter")
                check("抖动+全宽度扫描后侧栏仍完整", broken == 0, "异常出现 \(broken) 次")
            } else {
                check("找到可驱动的 NSSplitView", false, "拖不动就复现不了")
            }

            log(failures == 0 ? "==> 全部通过" : "==> 失败 \(failures) 项")
            exit(failures == 0 ? 0 : 1)
        }
        while true { spin(0.2) }
    }

    // MARK: 工具

    private static func findAllSplitViews(_ v: NSView) -> [NSSplitView] {
        var out: [NSSplitView] = []
        if let sv = v as? NSSplitView { out.append(sv) }
        for s in v.subviews { out += findAllSplitViews(s) }
        return out
    }

    private static func setDivider(_ sv: NSSplitView, to x: CGFloat) {
        sv.setPosition(x, ofDividerAt: 0)
        sv.layoutSubtreeIfNeeded()
    }

    /// 真鼠标拖动：mouseDown → dragged×N → mouseUp，全部经 win.sendEvent。
    /// ⚠️ NSEvent.mouseEvent 的 location 在 windowNumber 非 0 时按**窗口坐标**解释。
    private static func dragDivider(_ win: NSWindow, fromX: CGFloat, dx: CGFloat, tag: String) {
        let midY = win.frame.height / 2
        func ev(_ type: NSEvent.EventType, _ p: NSPoint) -> NSEvent? {
            NSEvent.mouseEvent(with: type,
                               location: p,
                               modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                               windowNumber: win.windowNumber, context: nil,
                               eventNumber: 0, clickCount: 1, pressure: 1.0)
        }
        let steps = 8
        for i in 0...steps {
            let p = NSPoint(x: fromX + dx * CGFloat(i) / CGFloat(steps), y: midY)
            let type: NSEvent.EventType = i == 0 ? .leftMouseDown
                : (i == steps ? .leftMouseUp : .leftMouseDragged)
            if let e = ev(type, p) { win.sendEvent(e) }
            spin(0.04)
            if i == steps / 2, let cv = win.contentView,
               let rep = cv.bitmapImageRepForCachingDisplay(in: cv.bounds) {
                cv.cacheDisplay(in: cv.bounds, to: rep)
                if let d = rep.representation(using: .png, properties: [:]) {
                    try? d.write(to: URL(fileURLWithPath: "/tmp/xsbar/\(tag)-mid.png"))
                }
            }
        }
        spin(0.2)
    }

    /// 判断侧栏是否还带着图标：在「错题本」行的高度上扫图标区（x 12..30pt）有没有非背景色像素。
    /// 选中行不参评（它的图标是主色），取错题本/学习档案两行。
    private static func sidebarHasIcons(_ host: NSView) -> Bool {
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return false }
        host.cacheDisplay(in: host.bounds, to: rep)
        let scale = Double(rep.pixelsWide) / Double(host.bounds.width)
        // 品牌行图标在 y≈60..90pt；错题本行在 y≈170 附近。扫 8..30pt 宽度带。
        for band in [60.0...92.0, 165.0...200.0] {
            var ink = 0
            for y in stride(from: Int(band.lowerBound * scale), to: Int(band.upperBound * scale), by: 2) {
                for x in stride(from: Int(10 * scale), to: Int(30 * scale), by: 2) {
                    guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                    let lum = Double(c.redComponent + c.greenComponent + c.blueComponent)
                    let bg: Double = 2.85 // 侧栏底 ≈ #EFEFEE，亮度和 ≈ 2.85
                    if abs(lum - bg) > 0.35 { ink += 1 }
                }
            }
            if ink > 10 { return true }
        }
        return false
    }

    /// 侧栏右边界：在若干采样行上找「灰侧栏底 → 白内容底」的最强竖直色阶
    private static func sidebarEdge(_ host: NSView) -> Int? {
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
        host.cacheDisplay(in: host.bounds, to: rep)
        let scale = Double(rep.pixelsWide) / Double(host.bounds.width)
        let pxW = rep.pixelsWide, pxH = rep.pixelsHigh
        func lum(_ x: Int, _ y: Int) -> Double {
            guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { return 0 }
            return Double(c.redComponent + c.greenComponent + c.blueComponent)
        }
        var bestX = -1, bestScore = 0.0
        // 只在 120..500pt（240..1000px）里找；跳过最上下各 1/4（避开标题栏/黑块）
        let x0 = Int(120 * scale), x1 = min(pxW - 2, Int(500 * scale))
        let y0 = pxH / 4, y1 = pxH * 3 / 4
        for x in x0...x1 {
            var d = 0.0
            var rows = 0
            for y in stride(from: y0, to: y1, by: 16) {
                d += abs(lum(x + 1, y) - lum(x, y))
                rows += 1
            }
            d /= Double(rows)
            if d > bestScore { bestScore = d; bestX = x }
        }
        guard bestScore > 0.05 else { return nil }
        return Int(Double(bestX) / scale)
    }

    /// cacheDisplay 位图（布局证据，材质会画成黑块）+ screencapture 真实合成图（材质证据）
    private static func capture(_ name: String) {
        guard let win = NSApp.windows.first(where: { $0.windowNumber == winNumber }),
              let cv = win.contentView else { return }
        if let rep = cv.bitmapImageRepForCachingDisplay(in: cv.bounds) {
            cv.cacheDisplay(in: cv.bounds, to: rep)
            if let d = rep.representation(using: .png, properties: [:]) {
                try? d.write(to: URL(fileURLWithPath: "/tmp/xsbar/\(name).png"))
            }
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-x", "-o", "-l", String(winNumber), "/tmp/xsbar/\(name)-real.png"]
        try? p.run()
        log("  · 截图 \(name)（+real）")
    }
}
