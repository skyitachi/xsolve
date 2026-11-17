import SwiftUI

// MARK: - 做题主界面（index.html 三栏布局的原生版）

struct TutorView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var state = TutorState()
    @State private var bootstrapped = false
    @AppStorage("xsolve_work_panel_hidden") private var workPanelHidden = false

    var body: some View {
        // 恒定左右两栏：左 = 题目（+ 可收起的做题区），右 = AI 助教。
        // 收起做题区后左栏只剩题目，自然成为「题目 | 对话」两栏；聊天视图不重建。
        HSplitView {
            VStack(spacing: 0) {
                ProblemPanel(state: state, workPanelHidden: $workPanelHidden)
                if !workPanelHidden {
                    Divider()
                    WorkPanel(state: state, onHide: { workPanelHidden = true })
                }
            }
            // 收起做题区后左栏只剩题目，收窄把宽度让给对话（否则题目下方一大片空白）
            .frame(minWidth: workPanelHidden ? 300 : 360,
                   idealWidth: workPanelHidden ? 420 : 560,
                   maxWidth: workPanelHidden ? 520 : .infinity)

            ChatPanel(state: state)
                .frame(minWidth: 380)
        }
        .frame(minWidth: 900, minHeight: 520)
        // 截图后 Cmd+V 直接进（与 Web 端 paste 处理一致），目标按鼠标所在面板决定
        .imagePaste(state: state)
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

struct ProblemPanel: View {
    @ObservedObject var state: TutorState
    @Binding var workPanelHidden: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                // 标题行只放「题目 + 题号 + 主题」，恢复按钮单独占一行：
                // 挤在同一个 HStack 里的话，左栏收到 300pt 时它会被顶出边界（它是唯一的恢复入口）
                HStack(spacing: 8) {
                    Label("题目", systemImage: "book.fill")
                        .font(.headline)
                        .fixedSize()
                    Spacer(minLength: 4)
                    Text("\(state.idx + 1) / \(max(state.problems.count, 1))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .fixedSize()
                    Text(state.currentProblem?.topic ?? "—")
                        .font(.caption)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Color.brand.opacity(0.12))
                        .clipShape(Capsule())
                        .foregroundStyle(Color.brand)
                }
                // 做题区收起后，这里是唯一的恢复入口 —— 必须有文字、且不能被挤掉
                if workPanelHidden {
                    Button {
                        workPanelHidden = false
                    } label: {
                        Label("显示做题区（答案输入 / 草稿板）", systemImage: "square.split.1x2")
                            .font(.caption)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .help("展开答案输入、工具栏与草稿板")
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
                    Text("题库为空。可以点「输入题目」或让 AI 出一道新题，也可以把题目图片直接拖到这里。")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // 整块题目区都能接图（与 Web 端 .panel-problem 一致：从 Finder 拖文件、从浏览器拖图片都行）
        .imageDrop(state: state, target: .problem)
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

struct WorkPanel: View {
    @ObservedObject var state: TutorState
    /// 收起做题区（由 TutorView 传，直接翻 AppStorage 状态位）
    var onHide: () -> Void = {}
    @State private var showProblemPicker = false   // 拍题/选题入口
    @State private var showAnswerPicker = false

    // 答案草稿存在 TutorState 里：做题区隐藏会销毁本视图，@State 会跟着丢
    private func submitCurrentAnswer() async {
        let answer = state.answerDraft
        state.answerDraft = ""
        await state.submitAnswer(answer)
    }

    var body: some View {
        VStack(spacing: 0) {
            // 标题行：做题区自己的折叠开关就放在这里（用户在做题区里，不用去标题栏找）
            HStack(spacing: 6) {
                Label("做题区", systemImage: "pencil.and.scribble")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button(action: onHide) {
                    Label("隐藏", systemImage: "chevron.down")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("隐藏做题区，题目与 AI 对话保留")
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 2)

            // 答案输入
            HStack(spacing: 8) {
                Text("最终答案：").font(.callout)
                TextField("在这里输入你的答案", text: $state.answerDraft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await submitCurrentAnswer() } }
                Button("提交答案") {
                    Task { await submitCurrentAnswer() }
                }
                .controlSize(.regular)
                .buttonStyle(.borderedProminent)
                .disabled(state.answerDraft.trimmingCharacters(in: .whitespaces).isEmpty || state.turnInFlight)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)

            Divider()

            // 工具条（对应 work-tools）：按宽度自动换行，窄栏下也不会把按钮推出可视区。
            // 注意别用 ScrollView(.horizontal) —— 桌面滚轮不拨它，右边界外的按钮等于消失。
            FlowLayout(spacing: 6, rowSpacing: 6) {
                Button {
                    showProblemPicker = true
                } label: { Label("拍题", systemImage: "camera.fill") }
                    .buttonStyle(.borderedProminent)

                Menu {
                    Button("选择图片（作为题目识别）") { pickImage { url in ingest(url, .problem) } }
                    Button("打开相机（Continuity Camera）") { CameraWindow.shared.show { img in
                        if let d = ImageUtil.jpegDataURL(from: img, maxEdge: 1600) { state.ingest(image: d, target: .problem) }
                    } }
                } label: { Label("相册选题", systemImage: "photo.on.rectangle") }
                    .buttonStyle(.bordered)

                Button { state.showManualInput = true } label: {
                    Label("输入题目", systemImage: "square.and.pencil")
                }
                .buttonStyle(.bordered)

                Menu {
                    Button("选择图片（我的解答）") { pickImage { url in ingest(url, .answer) } }
                    Button("打开相机（Continuity Camera）") { CameraWindow.shared.show { img in
                        if let d = ImageUtil.jpegDataURL(from: img, maxEdge: 1280) { state.ingest(image: d, target: .answer) }
                    } }
                } label: { Label("拍解答", systemImage: "camera.viewfinder") }
                    .buttonStyle(.bordered)

                // 草稿工具成组：画笔/橡皮 + 撤销 + 清空 + 识别
                ScratchToolPicker(model: state.scratch)
                toolButton("撤销", icon: "arrow.uturn.backward") { state.scratch.undo() }
                toolButton("清空", icon: "trash") { state.scratch.clear() }
                Button {
                    Task { await state.recognizeScratch() }
                } label: { Label("识别草稿", systemImage: "text.viewfinder") }
                    .buttonStyle(.bordered)
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            // 小号控件：同样的按钮在 560~760pt 宽度下能挤回一行，不用第二行只挂一个按钮
            .controlSize(.small)

            // 上传预览（解答图确认后发给 AI）
            if let up = state.pendingUpload {
                UploadPreviewBar(state: state, dataURL: up.dataURL)
            }

            Divider()

            // 草稿板
            ScratchCanvasView(model: state.scratch)
        }
        // 与 Web 端 .panel-work 一致：整块做题区都能接图，默认按「解答」处理
        .imageDrop(state: state, target: .answer)
    }

    private func toolButton(_ title: String, icon: String,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
        }
        .buttonStyle(.bordered)
    }

    private func ingest(_ url: URL, _ target: TutorState.UploadTarget) {
        ingestImageFile(url, state: state, target: target)
    }
}

// MARK: - 上传预览条

struct UploadPreviewBar: View {
    @ObservedObject var state: TutorState
    let dataURL: String

    var body: some View {
        HStack(spacing: 10) {
            if let img = ImageUtil.image(fromDataURL: dataURL) {
                Image(nsImage: img)
                    .resizable()
                    .scaledToFill()
                    // 固定方框：横图不能把整条挤爆
                    .frame(width: 72, height: 56)
                    .clipped()
                    .cornerRadius(6)
            }
            // 附言与右侧输入框是同一个正文：Web 端就是拿 textarea 的值当 caption
            TextField("附言（可选）", text: $state.draftInput)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1)
                .frame(minWidth: 40)
            // 按钮不许被挤压（窄栏下曾把「发给 AI 检查」压成「发给 AI…」）
            Button("发给 AI 检查") {
                Task { await state.sendPendingUpload() }
            }
            .buttonStyle(.borderedProminent)
            .fixedSize()
            Button("取消") { state.pendingUpload = nil }
                .fixedSize()
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.brand.opacity(0.05))
    }
}
