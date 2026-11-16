import SwiftUI

// MARK: - 做题主界面（index.html 三栏布局的原生版）

struct TutorView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var state = TutorState()
    @State private var bootstrapped = false

    var body: some View {
        VSplitView {
            HSplitView {
                // 左列：题目（上） + 做题区（下）
                VStack(spacing: 0) {
                    ProblemPanel(state: state)
                    Divider()
                    WorkPanel(state: state)
                }
                .frame(minWidth: 380)
            }
            // 右列：AI 助教
            ChatPanel(state: state)
                .frame(minWidth: 360)
        }
        .frame(minWidth: 900, minHeight: 520)
        .toolbar { toolbarContent }
        .sheet(isPresented: $state.showManualInput) {
            ManualInputDialog(state: state)
        }
        .sheet(isPresented: $state.showAbout) {
            AboutDialog { state.showAbout = false }
        }
        .sheet(item: proposalBinding) { p in
            ProposalDialog(state: state, problem: p)
        }
        .sheet(item: deleteBinding) { p in
            DeleteConfirmDialog(state: state, problem: p.problem, fromAI: p.fromAI)
        }
        .sheet(isPresented: cropBinding) {
            CropDialog(imageDataURL: state.cropSource ?? "") { cropped in
                state.confirmCrop(cropped)
            } onCancel: {
                state.cropSource = nil
            }
        }
        .onAppear {
            guard !bootstrapped else { return }
            bootstrapped = true
            Task { await state.bootstrap(model: model) }
        }
    }

    private var proposalBinding: Binding<ProposedProblem?> {
        Binding(get: { state.proposal }, set: { state.proposal = $0 })
    }

    private struct DeletePayload: Identifiable {
        let id = UUID()
        let problem: ProposedProblem
        let fromAI: Bool
    }
    private var deleteBinding: Binding<DeletePayload?> {
        Binding(get: {
            state.deleteProposal.map { DeletePayload(problem: $0.problem, fromAI: $0.fromAI) }
        }, set: { v in
            state.deleteProposal = v.map { ($0.problem, $0.fromAI) }
        })
    }

    private var cropBinding: Binding<Bool> {
        Binding(get: { state.cropSource != nil }, set: { if !$0 { state.cropSource = nil } })
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button { state.goPrev() } label: { Label("上一题", systemImage: "chevron.left") }
                .help("上一题")
            Text("\(state.idx + 1) / \(max(state.problems.count, 1))")
                .monospacedDigit()
                .frame(minWidth: 44)
            Button { state.goNext() } label: { Label("下一题", systemImage: "chevron.right") }
                .help("下一题")
            if model.user?.is_admin == true {
                Button {
                    if let p = state.currentProblem, !state.turnInFlight {
                        state.deleteProposal = (ProposedProblem(id: p.id, topic: p.topic, text: p.text, answer: nil, hints: nil, figure: p.figure, figureImage: nil), false)
                    }
                } label: { Label("删除当前题", systemImage: "trash") }
                    .help("删除当前题（管理员）")
            }
            Divider()
            Button { state.showAbout = true } label: { Label("关于", systemImage: "gearshape") }
        }
    }
}

// MARK: - 题目面板

private struct ProblemPanel: View {
    @ObservedObject var state: TutorState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("📘 题目", systemImage: "book.fill")
                        .font(.headline)
                    Spacer()
                    Text("\(state.idx + 1) / \(max(state.problems.count, 1))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Text(state.currentProblem?.topic ?? "—")
                        .font(.caption)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Color.brand.opacity(0.12))
                        .clipShape(Capsule())
                        .foregroundStyle(Color.brand)
                }
                if let p = state.currentProblem {
                    RichText(text: p.text)
                    if let fig = p.figureImage, let img = ImageUtil.image(fromDataURL: fig) {
                        VStack(spacing: 4) {
                            Image(nsImage: img)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: .infinity)
                                .cornerRadius(8)
                            Text("🖼️ 题目原图").font(.caption).foregroundStyle(.secondary)
                        }
                    } else if let fig = p.figure {
                        FigureView(figure: fig)
                    }
                } else {
                    Text("题库为空。可以点「输入题目」或让 AI 出一道新题。")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - 题目几何图（problem.js 的 SVG rect / 直角三角形）

struct FigureView: View {
    let figure: ProblemFigure

    var body: some View {
        if figure.type == "rect" {
            rectFigure
        } else if figure.type == "right-triangle" {
            TriangleFigure(figure: figure)
        } else {
            EmptyView()
        }
    }

    private var rectFigure: some View {
        let w = figure.width ?? 4, h = figure.height ?? 3
        let scale = min(180 / w, 130 / h)
        return VStack {
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color(hex: 0xDBEAFE))
                    .frame(width: w * scale, height: h * scale)
                    .overlay(RoundedRectangle(cornerRadius: 2).stroke(Color(hex: 0x1D4ED8), lineWidth: 2))
            }
            .frame(width: (w * scale) + 90, height: (h * scale) + 50)
            .overlay(alignment: .top) {
                Text("长 \(Int(w)) \(figure.unit ?? "")").font(.caption).foregroundStyle(Color(hex: 0x374151))
            }
            .overlay(alignment: .leading) {
                Text("宽 \(Int(h))\(figure.unit ?? "")").font(.caption).foregroundStyle(Color(hex: 0x374151))
                    .fixedSize()
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// 可拖动的直角三角形（a、b 边可拖）
private struct TriangleFigure: View {
    let figure: ProblemFigure
    @State private var a: Double
    @State private var b: Double

    init(figure: ProblemFigure) {
        self.figure = figure
        _a = State(initialValue: figure.a ?? 3)
        _b = State(initialValue: figure.b ?? 4)
    }

    private let scale: Double = 28
    private let origin = CGPoint(x: 80, y: 180)   // 直角顶点（视图坐标，上左原点）
    private var canvasH: Double { 220 }

    var body: some View {
        let aPt = CGPoint(x: origin.x, y: origin.y - a * scale)
        let bPt = CGPoint(x: origin.x + b * scale, y: origin.y)
        let c = (a * a + b * b).squareRoot()

        return ZStack {
            // 三角形
            Path { p in
                p.move(to: origin)
                p.addLine(to: bPt)
                p.addLine(to: aPt)
                p.closeSubpath()
            }
            .fill(Color(hex: 0xFDE68A))
            .overlay(Path { p in
                p.move(to: origin)
                p.addLine(to: bPt)
                p.addLine(to: aPt)
                p.closeSubpath()
            }.stroke(Color(hex: 0xB45309), lineWidth: 2))

            // 直角标记
            Path { p in
                p.move(to: CGPoint(x: origin.x, y: origin.y - 12))
                p.addLine(to: CGPoint(x: origin.x + 12, y: origin.y - 12))
                p.addLine(to: CGPoint(x: origin.x + 12, y: origin.y))
            }
            .stroke(Color(hex: 0xB45309), lineWidth: 1.5)

            // 标签
            Text("a = \(Int(a))")
                .position(x: origin.x - 26, y: (origin.y + aPt.y) / 2)
            Text("b = \(Int(b))")
                .position(x: (origin.x + bPt.x) / 2, y: origin.y + 14)
            Text("c = \(String(format: "%.2f", c))")
                .foregroundColor(Color(hex: 0x6D28D9))
                .position(x: (aPt.x + bPt.x) / 2 + 34, y: (aPt.y + bPt.y) / 2 - 10)

            Text("👆 拖动蓝点改变三角形")
                .font(.caption)
                .foregroundColor(.secondary)
                .position(x: 160, y: 14)

            // 拖动把手
            Circle()
                .fill(Color.brand)
                .frame(width: 14, height: 14)
                .overlay(Circle().stroke(.white, lineWidth: 2))
                .position(aPt)
                .gesture(
                    DragGesture(minimumDistance: 1).onChanged { g in
                        let newA = (origin.y - (aPt.y + g.translation.height)) / scale
                        a = min(10, max(1, (newA).rounded()))
                    }
                )
            Circle()
                .fill(Color.brand)
                .frame(width: 14, height: 14)
                .overlay(Circle().stroke(.white, lineWidth: 2))
                .position(bPt)
                .gesture(
                    DragGesture(minimumDistance: 1).onChanged { g in
                        let newB = (bPt.x + g.translation.width - origin.x) / scale
                        b = min(10, max(1, newB.rounded()))
                    }
                )
        }
        .frame(width: 320, height: canvasH)
        .frame(maxWidth: .infinity)
    }
}

// MARK: - 做题区（答案输入 + 工具条 + 草稿板）

private struct WorkPanel: View {
    @ObservedObject var state: TutorState
    @State private var answer = ""
    @State private var showProblemPicker = false   // 拍题/选题入口
    @State private var showAnswerPicker = false

    var body: some View {
        VStack(spacing: 0) {
            // 答案输入
            HStack(spacing: 8) {
                Text("最终答案：").font(.callout)
                TextField("在这里输入你的答案", text: $answer)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await state.submitAnswer(answer); answer = "" } }
                Button("提交答案") {
                    Task { await state.submitAnswer(answer); answer = "" }
                }
                .controlSize(.regular)
                .buttonStyle(.borderedProminent)
                .disabled(answer.trimmingCharacters(in: .whitespaces).isEmpty || state.turnInFlight)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)

            Divider()

            // 工具条（对应 work-tools；单行横向滚动是移动端语义，桌面直接排开）
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    Button {
                        showProblemPicker = true
                    } label: { Label("📷 拍题", systemImage: "camera") }
                        .buttonStyle(.borderedProminent)

                    Menu {
                        Button("选择图片（作为题目识别）") { pickImage { url in ingest(url, .problem) } }
                        Button("打开相机（Continuity Camera）") { CameraWindow.shared.show { img in
                            if let d = ImageUtil.jpegDataURL(from: img, maxEdge: 1600) { state.ingest(image: d, target: .problem) }
                        } }
                    } label: { Label("🖼️ 相册选题", systemImage: "photo") }
                        .buttonStyle(.bordered)

                    toolButton("✒️ 画笔", active: state.scratch.tool == "pen") { state.scratch.tool = "pen" }
                    toolButton("🧽 橡皮", active: state.scratch.tool == "eraser") { state.scratch.tool = "eraser" }
                    toolButton("↩️ 撤销") { state.scratch.undo() }
                    toolButton("🗑️ 清空") { state.scratch.clear() }
                    Button("👁️ 识别草稿") { Task { await state.recognizeScratch() } }
                        .buttonStyle(.bordered)

                    Menu {
                        Button("选择图片（我的解答）") { pickImage { url in ingest(url, .answer) } }
                        Button("打开相机（Continuity Camera）") { CameraWindow.shared.show { img in
                            if let d = ImageUtil.jpegDataURL(from: img, maxEdge: 1280) { state.ingest(image: d, target: .answer) }
                        } }
                    } label: { Label("📷 拍解答", systemImage: "camera.viewfinder") }
                        .buttonStyle(.bordered)

                    Button("✏️ 输入题目") { state.showManualInput = true }
                        .buttonStyle(.bordered)
                }
                .padding(.horizontal, 12).padding(.vertical, 6)
            }

            // 上传预览（解答图确认后发给 AI）
            if let up = state.pendingUpload {
                UploadPreviewBar(state: state, dataURL: up.dataURL)
            }

            Divider()

            // 草稿板
            ScratchCanvasView(model: state.scratch)
        }
    }

    private func toolButton(_ label: String, active: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).padding(.horizontal, 4)
        }
        .buttonStyle(.bordered)
        .tint(active ? Color.brand : Color.secondary)
    }

    private func ingest(_ url: URL, _ target: TutorState.UploadTarget) {
        guard let img = NSImage(contentsOf: url) else {
            state.errorMsg("图片读取失败：\(url.lastPathComponent)")
            return
        }
        let maxEdge: CGFloat = target == .problem ? 2000 : 1280
        guard let d = ImageUtil.jpegDataURL(from: img, maxEdge: maxEdge) else {
            state.errorMsg("图片处理失败")
            return
        }
        state.ingest(image: d, target: target)
    }
}

// MARK: - 上传预览条

private struct UploadPreviewBar: View {
    @ObservedObject var state: TutorState
    let dataURL: String
    @State private var caption = ""

    var body: some View {
        HStack(spacing: 10) {
            if let img = ImageUtil.image(fromDataURL: dataURL) {
                Image(nsImage: img)
                    .resizable()
                    .scaledToFit()
                    .frame(height: 60)
                    .cornerRadius(6)
            }
            TextField("附言（可选）", text: $caption)
                .textFieldStyle(.roundedBorder)
            Button("发给 AI 检查") {
                Task { await state.sendPendingUpload(caption: caption) }
            }
            .buttonStyle(.borderedProminent)
            Button("取消") { state.pendingUpload = nil }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.brand.opacity(0.05))
    }
}
