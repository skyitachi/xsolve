import AppKit
import SwiftUI

// MARK: - 回归探针：题目原图的显示尺寸
//
// 用法：`swift run XsolveMac --uifigure`（结果写 /tmp/xsolve-figure.log，跑完自动退出）
//
// 背景：题目原图是学生拍/截的照片，动辄 1000×1500。原来写 `.frame(maxWidth: .infinity)`，
// 一道题的图就吃掉一屏，题目文字和做题区全被挤下去（截图里就是这种）。
// Web 端规则是 `max-width:100%; max-height:220px`，且**不会把小图放大**
// （img 只有 max-*，而 SwiftUI 的 resizable 会拉伸）。
//
// 做法：用纯色（蓝）测试图渲染，扫位图里蓝色像素的包围盒 = 图片真实绘制尺寸，
// 比看截图猜准得多。

enum FigureProbe {
    static var active: Bool { CommandLine.arguments.contains("--uifigure") }

    private static let logURL = URL(fileURLWithPath: "/tmp/xsolve-figure.log")
    private static let outDir = "/tmp/xsolve-figure"

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
        if ok { log("  ✓ \(name) — \(detail)") } else {
            failures += 1
            log("  ✗ \(name) — \(detail)")
        }
    }

    private static func spin(_ seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    }

    private static func solid(_ w: Int, _ h: Int) -> NSImage {
        let img = NSImage(size: NSSize(width: w, height: h))
        img.lockFocus()
        NSColor(srgbRed: 0, green: 0, blue: 1, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: w, height: h).fill()
        img.unlockFocus()
        return img
    }

    @MainActor
    static func runAndExit() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

        log("==> 题目原图尺寸探针（限高 220 / 不放大 / 点击看大图）")

        // 名字, 图片, 栏宽, 期望高度区间, 期望宽度区间
        let cases: [(String, NSImage, CGFloat, ClosedRange<Int>, ClosedRange<Int>)] = [
            ("瘦高 900×1600", solid(900, 1600), 600, 210...226, 100...160),
            ("超宽 1600×400", solid(1600, 400), 600, 130...176, 560...600),
            ("小图 80×60", solid(80, 60), 600, 55...66, 74...86),
            ("方图 400×400", solid(400, 400), 600, 210...226, 210...226),
            // 窄栏：宽高都必须跟着缩，不能被撑破
            ("瘦高 @300 栏宽", solid(900, 1600), 300, 210...226, 100...160),
        ]

        for (name, img, width, wantH, wantW) in cases {
            let host = NSHostingView(rootView: AnyView(
                ProblemFigureImage(image: img)
                    .frame(width: width)
                    .background(Color.white)
                    .environment(\.colorScheme, .light)
            ))
            host.frame = NSRect(x: 0, y: 0, width: width, height: 400)
            host.appearance = NSAppearance(named: .aqua)
            host.layoutSubtreeIfNeeded()
            spin(0.25)
            host.layoutSubtreeIfNeeded()

            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
                check(name, false, "拿不到位图"); continue
            }
            host.cacheDisplay(in: host.bounds, to: rep)

            let box = blueBox(rep)
            if box == nil {
                check(name, false, "位图里找不到蓝色图片区域"); continue
            }
            let h = box!.height, w = box!.width
            log("  · \(name)：绘制 \(w)×\(h)pt（位图 \(rep.pixelsWide)×\(rep.pixelsHigh)）")
            check("\(name) 高度被限制", wantH.contains(h), "h=\(h) 期望 \(wantH)")

            // 小图不放大：宽度应贴近自然宽度（80），而不是栏宽 600
            check("\(name) 宽度合理", wantW.contains(w), "w=\(w) 期望 \(wantW)")

            // 边框必须贴着图片：原来用 .frame(maxWidth:) 时框架被撑满、图片居中留白，
            // 边框就画成了一个大空框（截图里那种）。图片两侧/上方不该有描边像素。
            let stray = strayStrokePixels(rep, box: box!)
            check("\(name) 没有多余空框", stray < 6, "图片外描边像素=\(stray)")

            let png = URL(fileURLWithPath: outDir).appendingPathComponent(
                name.replacingOccurrences(of: " ", with: "_").replacingOccurrences(of: "×", with: "x") + ".png")
            if let data = rep.representation(using: .png, properties: [:]) {
                try? data.write(to: png)
                log("  · 截图 → \(png.path)")
            }
        }

        // ---- 点击看大图：窗口必须真的建出来、尺寸合理 ----
        let screen = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1200, height: 800)

        let tall = solid(900, 1600)
        ImagePeekWindow.shared.show(tall)
        spin(0.25)
        if let w = peekWindow() {
            let ratio = w.frame.width / max(1, w.frame.height)
            log("  · 大图窗口 \(Int(w.frame.width))×\(Int(w.frame.height))")
            check("看大图窗口已创建", w.isVisible, "visible=\(w.isVisible)")
            check("看大图窗口不超出屏幕", w.frame.width <= screen.width && w.frame.height <= screen.height,
                  "\(Int(w.frame.width))×\(Int(w.frame.height)) ≤ \(Int(screen.width))×\(Int(screen.height))")
            check("看大图窗口保持图片比例", abs(ratio - 900.0 / 1600.0) < 0.06,
                  String(format: "%.3f vs 0.5625", ratio))
            check("看大图窗口装着图片", (w.contentView as? NSImageView)?.image != nil, "imageView")
        } else {
            check("看大图窗口已创建", false, "找不到标题为「题目原图」的可见窗口")
        }

        let small = solid(80, 60)
        ImagePeekWindow.shared.show(small)
        spin(0.25)
        if let w = peekWindow() {
            check("小图窗口尺寸受控", w.frame.width <= 600 && w.frame.height <= 500,
                  "\(Int(w.frame.width))×\(Int(w.frame.height))")
            check("小图窗口换成新图片",
                  (w.contentView as? NSImageView)?.image?.size.width == 80,
                  "image=\((w.contentView as? NSImageView)?.image?.size.width ?? 0)")
        } else {
            check("小图窗口已创建", false, "找不到窗口")
        }

        log(failures == 0 ? "==> 全部通过" : "==> 失败 \(failures) 项")
        exit(failures == 0 ? 0 : 1)
    }

    /// 最新的「题目原图」窗口（关闭过的旧窗口对象还留在 NSApp.windows 里，不能取 first）
    private static func peekWindow() -> NSWindow? {
        NSApp.windows.last { $0.title == "题目原图" && $0.isVisible }
    }

    /// 蓝色像素包围盒（像素坐标）
    private static func blueBox(_ rep: NSBitmapImageRep)
        -> (minX: Int, minY: Int, width: Int, height: Int)? {
        var minX = Int.max, maxX = -1, minY = Int.max, maxY = -1
        for y in 0..<rep.pixelsHigh {
            for x in 0..<rep.pixelsWide {
                guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                if c.blueComponent > 0.7 && c.redComponent < 0.35 && c.greenComponent < 0.35 {
                    if x < minX { minX = x }
                    if x > maxX { maxX = x }
                    if y < minY { minY = y }
                    if y > maxY { maxY = y }
                }
            }
        }
        guard maxX >= minX, maxY >= minY else { return nil }
        return (minX, minY, maxX - minX + 1, maxY - minY + 1)
    }

    /// 图片包围盒之外、与图片同高范围内出现的「灰色描边」像素数（>0 说明边框比图片大）
    private static func strayStrokePixels(_ rep: NSBitmapImageRep,
                                         box: (minX: Int, minY: Int, width: Int, height: Int)) -> Int {
        var count = 0
        let yFrom = max(0, box.minY - 4)
        let yTo = min(rep.pixelsHigh - 1, box.minY + box.height)
        for y in yFrom...max(yFrom, yTo) {
            for x in 0..<rep.pixelsWide {
                if x >= box.minX - 3 && x <= box.minX + box.width + 2 { continue }  // 图内/紧贴处不算
                guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                let lum = 0.299 * c.redComponent + 0.587 * c.greenComponent + 0.114 * c.blueComponent
                let sat = max(c.redComponent, c.greenComponent, c.blueComponent)
                    - min(c.redComponent, c.greenComponent, c.blueComponent)
                // 灰色描边：中等亮度 + 低饱和；正文黑字也低饱和，但它在图片下方，不在这个 y 范围
                if lum > 0.35 && lum < 0.92 && sat < 0.12 { count += 1 }
            }
        }
        return count
    }
}
