import AppKit
import SwiftUI

// MARK: - 视觉探针：把工具条/画布离屏渲染成 PNG
//
// 用法：`swift run XsolveMac --uisnap [--out /tmp/xsolve-snap]`（跑完自动退出）
//
// 目的：分段控件、激活态、画笔/橡皮提示、光标区域这些只能靠「看」来验收的东西，
// 在没有录屏权限的环境里用 NSHostingView 离屏渲染出图，比描述靠谱。

enum SnapProbe {
    static var active: Bool {
        CommandLine.arguments.contains("--uisnap") || CommandLine.arguments.contains("--uilive")
    }

    /// --uilive：只把窗口真的显示出来（Canvas 只在真实上屏时绘制），
    /// 停 8 秒给外部 screencapture 截图，然后退出。
    private static var liveOnly: Bool { CommandLine.arguments.contains("--uilive") }

    private static var outDir: String {
        if let i = CommandLine.arguments.firstIndex(of: "--out"),
           i + 1 < CommandLine.arguments.count {
            return CommandLine.arguments[i + 1]
        }
        return "/tmp/xsolve-snap"
    }

    @MainActor
    static func runAndExit() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

        let model = sharedModel
        model.canvasSize = CGSize(width: 560, height: 220)
        // 灌两笔，验证重放 + 橡皮覆盖
        model.tool = "pen"
        for i in 0..<40 {
            let x = 40 + Double(i) * 6
            let y = 90 + sin(Double(i) / 4) * 30
            if i == 0 { model.append(point: StrokePoint(x: x, y: y)) }
            else { model.extendLast(point: StrokePoint(x: x, y: y)) }
        }
        model.tool = "eraser"
        model.append(point: StrokePoint(x: 160, y: 90))
        model.extendLast(point: StrokePoint(x: 220, y: 90))

        func snap(_ name: String, _ view: some View, size: NSSize, dark: Bool = true) {
            // colorScheme 环境值比 host.appearance 可靠：后者常被 NSHostingView 忽略
            let host = NSHostingView(rootView: AnyView(
                view
                    .background(Color(nsColor: .windowBackgroundColor))
                    .environment(\.colorScheme, dark ? .dark : .light)
            ))
            host.frame = NSRect(origin: .zero, size: size)
            host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            host.layoutSubtreeIfNeeded()
            spin(0.35)
            host.layoutSubtreeIfNeeded()
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
                print("  ✗ \(name)：拿不到位图"); return
            }
            host.cacheDisplay(in: host.bounds, to: rep)
            guard let png = rep.representation(using: .png, properties: [:]) else {
                print("  ✗ \(name)：PNG 编码失败"); return
            }
            let url = URL(fileURLWithPath: outDir).appendingPathComponent("\(name).png")
            try? png.write(to: url)
            print("  ✓ \(name) → \(url.path)")

            // Canvas 的内容走 CALayer 绘制，cacheDisplay 抓不到（会得到白纸一张）。
            // 再用 layer.render(in:) 走一遍，专门用来验证「笔迹真的画上去了」。
            if let layer = host.layer,
               let rep2 = NSBitmapImageRep(
                   bitmapDataPlanes: nil,
                   pixelsWide: Int(size.width * 2), pixelsHigh: Int(size.height * 2),
                   bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                   colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
               let ctx2 = NSGraphicsContext(bitmapImageRep: rep2) {
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = ctx2
                ctx2.cgContext.scaleBy(x: 2, y: 2)
                layer.render(in: ctx2.cgContext)
                NSGraphicsContext.restoreGraphicsState()
                if let png2 = rep2.representation(using: .png, properties: [:]) {
                    let url2 = URL(fileURLWithPath: outDir).appendingPathComponent("\(name)-layer.png")
                    try? png2.write(to: url2)
                    print("  ✓ \(name)-layer → \(url2.path)")
                }
            }
        }

        print("==> 离屏渲染（输出目录 \(outDir)）")

        if liveOnly {
            // 真窗口：Canvas 只在真实上屏时执行绘制闭包，离屏快照永远是一张白纸
            let host = NSHostingView(rootView: AnyView(
                VStack(spacing: 0) {
                    HStack(spacing: 6) {
                        ScratchToolPicker(model: model)
                        Spacer()
                    }
                    .padding(8)
                    ScratchCanvasView(model: model)
                }
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, .dark)
            ))
            let win = NSWindow(contentRect: NSRect(x: 80, y: 300, width: 620, height: 300),
                               styleMask: [.titled, .closable], backing: .buffered, defer: false)
            win.title = "画布上屏验证"
            win.contentView = host
            win.orderFrontRegardless()
            print("  窗口已显示，等待外部截屏（8s）…")
            spin(8.0)
            print("  结束")
            exit(0)
        }

        model.tool = "pen"
        snap("toolbar-pen", toolbar, size: NSSize(width: 700, height: 46))
        model.tool = "eraser"
        snap("toolbar-eraser", toolbar, size: NSSize(width: 700, height: 46))
        model.tool = "pen"
        snap("toolbar-light", toolbar, size: NSSize(width: 700, height: 46), dark: false)
        snap("canvas-pen", canvas, size: NSSize(width: 560, height: 220))
        model.tool = "eraser"
        snap("canvas-eraser", canvas, size: NSSize(width: 560, height: 220))

        exit(0)
    }

    @MainActor
    private static let sharedModel = ScratchModel()

    @MainActor
    private static var toolbar: some View {
        HStack(spacing: 6) {
            ScratchToolPicker(model: sharedModel)
            Text("↩️ 撤销").padding(.horizontal, 8).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
            Text("🗑️ 清空").padding(.horizontal, 8).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
        }
        .padding(10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    @MainActor
    private static var canvas: some View {
        ScratchCanvasView(model: sharedModel)
            .frame(width: 560, height: 220)
    }

    @MainActor
    private static func spin(_ seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    }
}
