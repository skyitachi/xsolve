# xsolve macOS 原生客户端

Web 前端（`frontend/`）的 macOS 原生版本，技术栈 **SwiftUI + AppKit + WebKit（KaTeX 渲染）+ AVFoundation（语音/相机）+ Speech（实时转写）**，零第三方依赖。后端不做任何改动 —— 客户端通过 HTTP + SSE 对接现有 Node 服务。

## 功能对照（与 Web 端一一对齐）

| Web 页面 | 原生实现 |
| --- | --- |
| `index.html` 做题主界面 | `TutorView`：三栏（题目 / 做题区+草稿板 / AI 助教），SSE 流式对话、工具调用卡片、分步作图卡片、出题/删除确认弹窗 |
| `login.html` 登录 | `LoginView`：登录 / 注册（学生邀请码）/ 游客试用 / 服务器地址与自签证书设置 |
| `wrong-book.html` 错题本 | `WrongBookView`：本子 CRUD、筛选排序、详情与复习流水、错因标注、拍照解析录入、题库挑题加入、重做深链（复习标记 review=true） |
| `student-memory.html` 学习档案 | `MemoryView`：统计卡、AI 画像、每日正确率图、主题掌握度、动笔习惯、答题流水、记忆事实、手动固化画像 |
| `my-children.html` 我的孩子 | `MyChildrenView`：孩子卡片（学习统计）、会话查看、绑定码/邀请码、解绑 |
| `eval.html` / `student-eval.html` 评估 | `EvalView`：总览、Turns 分页（触发 Judge）、会话评估、学生评估 |
| `prompts.html` Prompt 管理 | `PromptsView`：版本列表、内容查看、新建、激活、删除 |
| `settings.html` 模型配置 | `ModelSettingsView`：通用/主对话/视觉/Judge 四组 API 配置 + 连接测试 |
| `accounts.html` 账号管理 | `AccountsView`：用户表、新建、重置密码、停用、设管、改名、删除、游客清理、审计日志 |
| 账户弹窗 | `AccountDialog`：改密、切换查看孩子、邀请码/绑定码、按角色裁剪的页面入口 |

关键机制同样保留：

- **草稿**：全量笔画模型（`{t:pen|eraser, p:[{x,y}]}`），每轮对话前同步笔画数 + 白底 JPEG 草稿图；识别缓存失效机制由服务端处理。
- **题目锚点**：turn 请求显式携带 `currentProblemId`；切题 PATCH session。
- **错题深链重做**：`PATCH /api/session/:id {currentProblemId, review:true}`，等级推进由服务端结算。
- **Markdown + LaTeX**：复用后端 `/vendor` 下的 marked + KaTeX 本地资源（WKWebView），与 Web 端渲染完全一致。
- **会话持久化**：按「账号 × 角色」保存 session id，语义与 Web 端 localStorage 一致。

## 构建与运行

```bash
# 先起后端（仓库根目录，Node 26）
SKIP_STARTUP_CHECK=1 DB_PATH=$PWD/xsolve.db node backend/server.js

# 开发运行（无麦克风/相机权限声明，语音与相机功能不可用）
cd macos && swift run

# 打包成 .app（启用语音 + 相机权限声明；局域网 http 不受 ATS 限制）
cd macos && ./scripts/make-app.sh
open XsolveMac.app
```

- 默认服务器地址 `http://localhost:8765`，可在登录页「服务器设置」里改（NAS 部署填 `https://<NAS>:8443` 并打开「允许自签名证书」，真证书无需打开）。
- macOS 13+，Apple Silicon / Intel 均可。

## 接口契约自检（无界面）

客户端用到的每个接口都真跑一遍，并按「界面里实际使用的模型」解码，用来发现字段/类型漂移：

```bash
swift run XsolveMac --selftest --base http://localhost:8765            # 22 项
swift run XsolveMac --selftest --base http://localhost:8765 --turn     # 额外跑一次真实 SSE 对话
# 账号可用 --user / --password 覆盖（默认 demo / demo123）
```

退出码 0 = 全绿。改后端返回体或客户端模型后，先跑它再手点界面。

## 与 Web 端的实现差异（踩过的坑）

- **SSE 分帧不能靠 `AsyncBytes.lines`**：它不产出空行，拼不回 `\n\n` 分隔符，会一条事件都收不到且不报错。已改为按字节扫描。
- **macOS 没有 `AVAudioSession`**：语音权限走 `AVCaptureDevice.requestAccess(for: .audio)`；录音与实时转写共用同一个 `AVAudioEngine` 的 tap（同时写 WAV + 喂 `SFSpeechAudioBufferRecognitionRequest`），避免抢麦克风。
- **`Shape.path(in:)` 的入参是 `CGRect`**（不是 `CGSize`），`NSButton` 也没有 `onAction` —— 相机窗口用 `ClosureButton` 包了一层 target/action。

## 结构

```
macos/
├── Package.swift
├── scripts/make-app.sh          # 打包 .app + Info.plist（权限声明）
└── Sources/XsolveMac/
    ├── App.swift                # 入口、全局状态、侧栏导航
    ├── Core/
    │   ├── APIClient.swift      # Cookie 会话、JSON 请求、SSE 流（取消即断流）
    │   ├── Models.swift         # 全部 API 的 Codable 模型 + JSONValue
    │   ├── RichText.swift       # marked + KaTeX 渲染（WKWebView，自适高）
    │   ├── SelfTest.swift       # --selftest 接口契约自检
    │   └── Util.swift           # 图片/DataURL/裁剪/时间格式化
    └── Features/
        ├── LoginView.swift
        ├── Tutor/               # 做题主界面（状态编排、草稿、聊天、上传、语音、弹窗）
        ├── WrongBookView.swift
        ├── MemoryView.swift
        ├── MyChildrenView.swift
        ├── EvalView.swift
        ├── PromptsView.swift
        ├── ModelSettingsView.swift
        ├── AccountsView.swift
        └── AccountDialog.swift
```
