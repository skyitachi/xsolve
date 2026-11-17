import SwiftUI
import AppKit

// MARK: - 自动登录（给界面截图/人工验收用）
//
// 用法：`.build/debug/XsolveMac --uiauto [--base http://localhost:8765]`
// 用 demo 账号登录后直接进主界面，省掉「重启就掉回登录页」这一步，
// 这样 screencapture 拍到的才是真正的做题界面而不是登录页。

@MainActor
enum AutoProbe {
    static var active: Bool { CommandLine.arguments.contains("--uiauto") }

    private static func base() -> String? {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--base"), i + 1 < args.count { return args[i + 1] }
        return nil
    }

    private static let logURL = URL(fileURLWithPath: "/tmp/xsolve-uiauto.log")

    private static func log(_ s: String) {
        let line = s + "\n"
        if let h = try? FileHandle(forWritingTo: logURL) {
            h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close()
        } else {
            try? line.write(to: logURL, atomically: true, encoding: .utf8)
        }
    }

    static func autorun() {
        // 同步置位，挡住 RootView.onAppear 里那次 bootstrap（它会用 me() 的结果把 user 覆盖成 nil）
        AppModel.shared.bootstrapped = true
        log("args=\(CommandLine.arguments.dropFirst().joined(separator: " "))")
        Task { @MainActor in
            if let b = base() { APIClient.shared.baseURL = b }
            log("base=\(APIClient.shared.baseURL)")
            let m = AppModel.shared
            // 截图场景需要指定做题区展开/收起，免得手工点
            let args = CommandLine.arguments
            if args.contains("--hidework") {
                UserDefaults.standard.set(true, forKey: "xsolve_work_panel_hidden")
            } else if args.contains("--showwork") {
                UserDefaults.standard.set(false, forKey: "xsolve_work_panel_hidden")
            }
            do {
                let u = try await APIClient.shared.login(username: "demo", password: "demo123")
                m.applyLogin(u)
                log("login ok \(u.username)")
            } catch {
                log("login FAILED \(error.localizedDescription)")
            }
            m.bootstrapped = true
            // 抢到前台，screencapture 才能拍到本窗口而不是别的应用（等窗口先建出来）
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            for w in NSApp.windows {
                if let si = args.firstIndex(of: "--size"), si + 1 < args.count {
                    let p = args[si + 1].split(separator: "x")
                    if p.count == 2, let width = Double(p[0]), let height = Double(p[1]) {
                        w.setContentSize(NSSize(width: width, height: height))
                        w.center()
                    }
                }
                w.orderFrontRegardless()
                // 无 bundle 的进程抢不到前台焦点，截图会被别的应用盖住 —— 探针模式下浮在最上层
                w.level = .floating
            }
        }
    }
}
