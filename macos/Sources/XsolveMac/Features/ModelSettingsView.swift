import SwiftUI

// MARK: - 模型配置（settings.html，管理员）
// 三组独立 API（主对话 / 视觉 / Judge）+ 通用 fallback，与 Web 端表单一一对应。

struct ModelSettingsView: View {
    let api = APIClient.shared

    @State private var commonApiKey = ""
    @State private var commonBaseUrl = ""
    @State private var chatApiKey = ""
    @State private var chatBaseUrl = ""
    @State private var chatModel = ""
    @State private var visionApiKey = ""
    @State private var visionBaseUrl = ""
    @State private var visionModel = ""
    @State private var judgeApiKey = ""
    @State private var judgeBaseUrl = ""
    @State private var judgeModel = ""

    @State private var effective: EffectiveSettings?
    @State private var message: String?
    @State private var testMsg: String?
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("🔑 模型配置").font(.title2.bold())
                Text("留空的字段回退到 .env；保存后立即生效（无需重启）。")
                    .font(.footnote).foregroundStyle(.secondary)

                if let m = message { Text(m).foregroundStyle(.secondary).font(.footnote) }

                GroupBox("通用（Fallback）") {
                    moduleFields(apiKey: $commonApiKey, baseUrl: $commonBaseUrl, model: .constant(""), showModel: false,
                                 effectiveKey: effective?.common?.apiKey, effectiveBase: effective?.common?.baseUrl, effectiveModel: nil,
                                 onTest: nil)
                }
                GroupBox("主对话（chat）") {
                    moduleFields(apiKey: $chatApiKey, baseUrl: $chatBaseUrl, model: $chatModel, showModel: true,
                                 effectiveKey: effective?.chat?.apiKey, effectiveBase: effective?.chat?.baseUrl, effectiveModel: effective?.chat?.model,
                                 onTest: { await test("chat") })
                }
                GroupBox("视觉（vision）") {
                    moduleFields(apiKey: $visionApiKey, baseUrl: $visionBaseUrl, model: $visionModel, showModel: true,
                                 effectiveKey: effective?.vision?.apiKey, effectiveBase: effective?.vision?.baseUrl, effectiveModel: effective?.vision?.model,
                                 onTest: { await test("vision") })
                }
                GroupBox("Judge（评估）") {
                    moduleFields(apiKey: $judgeApiKey, baseUrl: $judgeBaseUrl, model: $judgeModel, showModel: true,
                                 effectiveKey: effective?.judge?.apiKey, effectiveBase: effective?.judge?.baseUrl, effectiveModel: effective?.judge?.model,
                                 onTest: { await test("judge") })
                }

                if let t = testMsg { Text(t).font(.footnote).foregroundStyle(.secondary) }

                HStack {
                    Button {
                        Task { await save() }
                    } label: {
                        if busy { ProgressView().controlSize(.small) } else { Text("保存配置") }
                    }
                    .buttonStyle(.borderedProminent)
                    Button("重新读取") { Task { await load() } }
                    Spacer()
                }
            }
            .padding(18)
        }
        .onAppear { Task { await load() } }
    }

    @ViewBuilder
    private func moduleFields(apiKey: Binding<String>, baseUrl: Binding<String>, model: Binding<String>, showModel: Bool,
                              effectiveKey: SettingField?, effectiveBase: SettingField?, effectiveModel: SettingField?,
                              onTest: (() async -> Void)?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    labeledField("API Key", text: apiKey, placeholder: effectiveKey?.value ?? "（未设置）")
                    Text(sourceNote(effectiveKey)).font(.caption2).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 4) {
                    labeledField("Base URL", text: baseUrl, placeholder: effectiveBase?.value ?? "（默认）")
                    Text(sourceNote(effectiveBase)).font(.caption2).foregroundStyle(.secondary)
                }
                if showModel {
                    VStack(alignment: .leading, spacing: 4) {
                        labeledField("模型名", text: model, placeholder: effectiveModel?.value ?? "（未设置）")
                        Text(sourceNote(effectiveModel)).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                if let t = onTest {
                    Button("测试连接") { Task { await t() } }
                        .controlSize(.small)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func labeledField(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        HStack(spacing: 6) {
            Text(label).font(.caption).frame(width: 52, alignment: .leading)
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11, design: .monospaced))
                .frame(width: 260)
        }
    }

    private func sourceNote(_ f: SettingField?) -> String {
        guard let f else { return "" }
        var parts: [String] = []
        if let s = f.source { parts.append(s) }
        if f.set == true { parts.append("已覆盖 .env") }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        do {
            let r: EffectiveSettings = try await api.request("GET", "api/settings", body: nil as [String: String]?)
            effective = r
        } catch {
            message = "读取失败：\(error.localizedDescription)"
        }
    }

    private func save() async {
        busy = true
        defer { busy = false }
        let body: [String: String?] = [
            "commonApiKey": commonApiKey.isEmpty ? nil : commonApiKey,
            "commonBaseUrl": commonBaseUrl.isEmpty ? nil : commonBaseUrl,
            "chatApiKey": chatApiKey.isEmpty ? nil : chatApiKey,
            "chatBaseUrl": chatBaseUrl.isEmpty ? nil : chatBaseUrl,
            "chatModel": chatModel.isEmpty ? nil : chatModel,
            "visionApiKey": visionApiKey.isEmpty ? nil : visionApiKey,
            "visionBaseUrl": visionBaseUrl.isEmpty ? nil : visionBaseUrl,
            "visionModel": visionModel.isEmpty ? nil : visionModel,
            "judgeApiKey": judgeApiKey.isEmpty ? nil : judgeApiKey,
            "judgeBaseUrl": judgeBaseUrl.isEmpty ? nil : judgeBaseUrl,
            "judgeModel": judgeModel.isEmpty ? nil : judgeModel,
        ]
        do {
            _ = try await api.requestOK("PUT", "api/settings", body: body.compactMapValues { $0 } as [String: String])
            message = "配置已保存"
            await load()
        } catch {
            message = "保存失败：\(error.localizedDescription)"
        }
    }

    private func test(_ module: String) async {
        testMsg = "测试中…"
        let body: [String: String] = {
            switch module {
            case "vision": return ["module": module, "apiKey": visionApiKey, "baseUrl": visionBaseUrl, "model": visionModel]
            case "judge": return ["module": module, "apiKey": judgeApiKey, "baseUrl": judgeBaseUrl, "model": judgeModel]
            default: return ["module": "chat", "apiKey": chatApiKey, "baseUrl": chatBaseUrl, "model": chatModel]
            }
        }()
        do {
            let r: TestResp = try await api.request("POST", "api/settings/test", body: body)
            testMsg = (r.ok == true ? "✅ " : "❌ ") + (r.message ?? "")
        } catch {
            testMsg = "❌ \(error.localizedDescription)"
        }
    }
}
