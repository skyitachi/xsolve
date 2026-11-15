import SwiftUI

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
                    model.canvasSize = size
                    model.render(in: CGRect(origin: .zero, size: size))
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
            .overlay(alignment: .bottomLeading) {
                Text("在草稿区写过程；或用上方工具上传/输入题目")
                    .font(.caption)
                    .foregroundStyle(.secondary.opacity(0.7))
                    .padding(6)
                    .allowsHitTesting(false)
            }
            .onAppear { model.canvasSize = geo.size }
            .onChange(of: geo.size) { model.canvasSize = $0 }
        }
    }
}
