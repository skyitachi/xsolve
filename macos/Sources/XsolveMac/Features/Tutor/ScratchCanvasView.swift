import SwiftUI
import AppKit

// MARK: - 草稿画布（scratch.js 语义：全量笔画 + 撤销 + 重放）
// 坐标一律是画布左上原点的 CSS 像素；画布尺寸变化时按笔画重放（Canvas 天然支持）。

struct ScratchCanvasView: View {
    @ObservedObject var model: ScratchModel
    @State private var drawingStroke: Int = -1   // 正在写的笔画下标（-1 = 未在写）

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                Color.paperBG
                Canvas { ctx, size in
                    model.draw(in: ctx)
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { g in
                        let p = StrokePoint(x: Double(g.location.x), y: Double(g.location.y))
                        if drawingStroke < 0 {
                            model.append(point: p)
                            drawingStroke = model.strokes.count - 1
                        } else {
                            model.extendLast(point: p)
                        }
                    }
                    .onEnded { _ in
                        drawingStroke = -1
                    }
            )
            // 光标跟着工具走：不提示的话用户根本不知道这块能画
            .overlay(CursorArea(cursor: ScratchCursor.cursor(for: model.tool)))
            .overlay(alignment: .bottomLeading) {
                Text(model.tool == "eraser" ? "橡皮：擦掉笔迹（18pt）" : "在草稿区写过程；或用上方工具上传/输入题目")
                    .font(.caption)
                    .foregroundStyle(Color(hex: 0x6B7280).opacity(0.75))
                    .padding(6)
                    .allowsHitTesting(false)
            }
            .onAppear { model.canvasSize = geo.size }
            .onChange(of: geo.size) { model.canvasSize = $0 }
        }
    }
}

// MARK: - 工具选择（画笔 / 橡皮）
//
// 必须自己 observe ScratchModel：TutorState 只是持有 scratch，并没有转发它的
// objectWillChange，从外层读 state.scratch.tool 的话，切换后高亮永远不会动。

struct ScratchToolPicker: View {
    @ObservedObject var model: ScratchModel

    private var selection: Binding<String> {
        Binding(get: { model.tool }, set: { model.tool = $0 })
    }

    var body: some View {
        Picker("工具", selection: selection) {
            Text("画笔").tag("pen")
            Text("橡皮").tag("eraser")
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 132)
        // 快捷键用 ⌘1/⌘2 而不是裸 P/E：裸字母会被 SwiftUI 当成菜单快捷键优先消费，
        // 在「最终答案」输入框里就打不出 p 和 e 了。
        .background {
            ZStack {
                Button("") { model.tool = "pen" }
                    .keyboardShortcut("1", modifiers: .command)
                Button("") { model.tool = "eraser" }
                    .keyboardShortcut("2", modifiers: .command)
                Button("") { model.undo() }
                    .keyboardShortcut("z", modifiers: [.command, .option])
                Button("") { model.clear() }
                    .keyboardShortcut("k", modifiers: [.command, .shift])
            }
            .opacity(0)
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
        }
    }
}

// MARK: - 画布光标

enum ScratchCursor {
    static func cursor(for tool: String) -> NSCursor {
        tool == "eraser" ? ring(diameter: ScratchModel.eraserWidth) : .crosshair
    }

    /// 橡皮用空心圆，直径与笔迹宽度一致，能看出会擦多宽
    private static func ring(diameter: CGFloat) -> NSCursor {
        let d = max(diameter, 8)
        let size = NSSize(width: d + 2, height: d + 2)
        let img = NSImage(size: size)
        img.lockFocus()
        let path = NSBezierPath(ovalIn: NSRect(x: 1, y: 1, width: d, height: d))
        path.lineWidth = 1.5
        NSColor.black.withAlphaComponent(0.85).setStroke()
        path.stroke()
        NSColor.white.withAlphaComponent(0.85).setStroke()
        path.lineWidth = 0.5
        path.stroke()
        img.unlockFocus()
        return NSCursor(image: img, hotSpot: NSPoint(x: size.width / 2, y: size.height / 2))
    }
}

/// 只负责挂光标矩形，不参与事件（hitTest 返回 nil，不会挡住下面的手势）
struct CursorArea: NSViewRepresentable {
    let cursor: NSCursor

    func makeNSView(context: Context) -> CursorView { CursorView(cursor: cursor) }
    func updateNSView(_ v: CursorView, context: Context) { v.cursor = cursor }

    final class CursorView: NSView {
        var cursor: NSCursor {
            didSet { window?.invalidateCursorRects(for: self) }
        }

        init(cursor: NSCursor) {
            self.cursor = cursor
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { fatalError("不支持") }

        override func resetCursorRects() {
            addCursorRect(bounds, cursor: cursor)
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}
