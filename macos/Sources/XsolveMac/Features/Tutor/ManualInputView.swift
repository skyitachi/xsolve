import AVFoundation
import Speech
import SwiftUI

// MARK: - 手动输入题目（含语音输入 + 录音，voice.js 语义）

struct ManualInputDialog: View {
    @ObservedObject var state: TutorState
    @State private var text = ""
    @State private var voice = VoiceInputModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("✏️ 手动输入题目").font(.headline)
            Text("输入题目文本（公式可用 $...$ 包裹 LaTeX），或点 🎤 语音输入（同时保存录音），AI 会自动判断题型、生成答案和提示。")
                .font(.footnote).foregroundStyle(.secondary)

            HStack(alignment: .top, spacing: 8) {
                TextEditor(text: $text)
                    .font(.body)
                    .frame(height: 130)
                    .padding(4)
                    .background(Color.gray.opacity(0.08))
                    .cornerRadius(8)
                Button {
                    voice.toggle(text: text) { updated in
                        text = updated
                    }
                } label: {
                    Image(systemName: voice.isRecording ? "stop.circle.fill" : "mic.circle")
                        .font(.system(size: 28))
                        .foregroundStyle(voice.isRecording ? .red : Color.brand)
                }
                .buttonStyle(.plain)
                .disabled(!voice.available)
                .help(voice.available ? "语音输入（同时录音）" : "语音不可用（请使用打包后的 .app 运行）")
            }

            if !voice.statusText.isEmpty {
                Text(voice.statusText)
                    .font(.footnote)
                    .foregroundStyle(voice.isError ? .red : .secondary)
            }

            if voice.hasRecording {
                HStack(spacing: 10) {
                    Text("⏱️ \(voice.durationText)").font(.caption.monospacedDigit())
                    if let url = voice.fileURL {
                        Button("▶︎ 播放") { voice.play() }
                        Button("丢弃") { voice.discard() }
                    }
                }
                .padding(8)
                .background(Color.gray.opacity(0.08))
                .cornerRadius(8)
            }

            Spacer()

            HStack {
                Button("取消") { state.showManualInput = false }
                Spacer()
                Button("提交给 AI 处理") {
                    submit()
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !voice.hasRecording)
            }
        }
        .padding(18)
        .frame(width: 560, height: 400)
        .onDisappear { voice.stop() }
    }

    private func submit() {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty || voice.hasRecording else { return }
        state.showManualInput = false
        state.userMsg(content.isEmpty ? "（语音输入题目）" : content)
        let audio: (mediaType: String, data: String)? = voice.takeRecordingBase64()
        let prompt = content.isEmpty
            ? "（学生用语音说了一道题，请听录音识别题目并处理）"
            : "请根据以下题目内容，判断题型，并调用 propose_problem 工具向我提议这道新题：\n\n\(content)"
        Task { await state.runTurn(prompt, audio: audio) }
        voice.discard()
    }
}

// MARK: - 语音输入（录音 + 实时转写）

@MainActor
final class VoiceInputModel: ObservableObject {
    @Published var isRecording = false
    @Published var statusText = ""
    @Published var isError = false
    @Published var hasRecording = false
    @Published var durationText = "0:00"

    private var player: AVAudioPlayer?
    private var timer: Timer?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var audioEngine: AVAudioEngine?
    private var audioFile: AVAudioFile?
    private var finalTranscript = ""
    private(set) var fileURL: URL?

    /// 无 Info.plist 的裸进程（swift run）里申请麦克风权限会崩 —— 检测后才启用
    var available: Bool {
        Bundle.main.bundleIdentifier != nil
            || Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil
    }

    func toggle(text: String, onUpdate: @escaping (String) -> Void) {
        if isRecording { stop() } else { start(text: text, onUpdate: onUpdate) }
    }

    private func start(text: String, onUpdate: @escaping (String) -> Void) {
        isError = false
        finalTranscript = text.isEmpty ? "" : text + " "

        // macOS 上没有 AVAudioSession，权限走 AVCaptureDevice
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] ok in
            Task { @MainActor in
                guard let self else { return }
                guard ok else {
                    self.isError = true
                    self.statusText = "❌ 麦克风权限被拒绝（系统设置 → 隐私与安全性 → 麦克风）"
                    return
                }
                self.beginRecording(onUpdate: onUpdate)
            }
        }
    }

    private func beginRecording(onUpdate: @escaping (String) -> Void) {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else {
            isError = true
            statusText = "❌ 没有可用的麦克风输入"
            return
        }

        // 录音存盘（失败不影响转写：转写文字仍可提交）
        let wav = FileManager.default.temporaryDirectory
            .appendingPathComponent("xsolve-voice-\(Int(Date().timeIntervalSince1970)).wav")
        let file = try? AVAudioFile(forWriting: wav, settings: fmt.settings)
        audioFile = file
        fileURL = file == nil ? nil : wav

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        request = req
        audioEngine = engine

        input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buf, _ in
            req.append(buf)
            try? file?.write(from: buf)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            audioEngine = nil
            isError = true
            statusText = "❌ 麦克风启动失败：\(error.localizedDescription)"
            return
        }

        SFSpeechRecognizer.requestAuthorization { [weak self] auth in
            Task { @MainActor in
                guard let self else { return }
                if auth == .authorized {
                    self.listen(onUpdate: onUpdate)
                } else {
                    self.statusText = "🎤 正在录音...（语音转文字不可用，但录音会保存）"
                }
            }
        }

        isRecording = true
        statusText = "🎤 正在聆听..."
        let start = Date()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.isRecording else { return }
                let s = Int(Date().timeIntervalSince(start))
                self.durationText = "\(s / 60):\(String(format: "%02d", s % 60))"
            }
        }
    }

    /// 在已启动的音频引擎上挂识别任务（引擎与录音文件复用，不重复开设备）
    private func listen(onUpdate: @escaping (String) -> Void) {
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
        guard let request, let recognizer else { return }
        recognizer.recognitionTask(with: request) { [weak self] result, err in
            Task { @MainActor in
                guard let self else { return }
                if let r = result {
                    let s = r.bestTranscription.formattedString
                    onUpdate(self.finalTranscript + s)
                    self.statusText = "🎤 识别中: \(s)"
                } else if err != nil, self.isRecording {
                    self.statusText = "🎤 正在录音...（转写已停止，录音继续）"
                }
            }
        }
    }

    func stop() {
        guard isRecording else { return }
        isRecording = false
        timer?.invalidate()
        audioFile = nil
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine = nil
        request?.endAudio()
        request = nil
        if fileURL != nil {
            hasRecording = true
            statusText = "已录完，可播放试听或直接提交"
        } else {
            statusText = "已停止录音（未能保存音频文件，可用识别出的文字提交）"
        }
    }

    func play() {
        guard let url = fileURL else { return }
        player = try? AVAudioPlayer(contentsOf: url)
        player?.play()
    }

    func discard() {
        player?.stop()
        if let url = fileURL { try? FileManager.default.removeItem(at: url) }
        fileURL = nil
        hasRecording = false
        statusText = "🗑️ 已丢弃录音"
    }

    /// 取出录音的 base64（提交后即清空句柄，不删文件 —— 后端收到后由 turn 落库）
    func takeRecordingBase64() -> (mediaType: String, data: String)? {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return nil }
        return ("audio/wav", data.base64EncodedString())
    }
}
