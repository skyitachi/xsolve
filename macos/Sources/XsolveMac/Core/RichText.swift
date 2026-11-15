import SwiftUI
import WebKit

// MARK: - Markdown + KaTeX 富文本渲染
//
// 与 Web 端完全同一套渲染链：marked（Markdown）+ KaTeX（数学公式），
// 资源直接复用后端静态目录 /vendor 下的本地化文件（离线可用，无 CDN 依赖）。
// WKWebView 是 macOS 原生框架（WebKit），这是原生应用里渲染 LaTeX 的正路。

final class RichTextHeightBox: ObservableObject {
    @Published var height: CGFloat = 28
}

struct RichText: View {
    /// 诊断用：累计创建过多少个 WKWebView（每个都会拉起一个 WebContent 进程）
    nonisolated(unsafe) static var createdCount = 0
    /// 同时存活的上限，超出的消息降级为原生文本（安全阀，防止任何路径失控）
    nonisolated(unsafe) static var liveCount = 0

    let text: String
    /// true = 用户输入（先做 HTML 转义再渲染，防注入），与 Web 端 escape 语义一致
    var isUserInput: Bool = false
    var fontSize: CGFloat = 14

    @StateObject private var box = RichTextHeightBox()

    var body: some View {
        // 纯文本（无 Markdown / 公式）用原生 Text 渲染：
        // 一条普通消息不必为此拉起一个 WebContent 进程，滚动也更跟手。
        if RichText.canRenderNatively(text) {
            Text(text)
                .font(.system(size: fontSize))
                .lineSpacing(3)
                .foregroundStyle(Color(hex: 0x1F2937))
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        } else {
            MarkdownWebView(text: text, isUserInput: isUserInput, fontSize: fontSize, heightBox: box)
                .frame(height: max(box.height, 12))
        }
    }

    /// 判定能否用原生 Text 渲染（保守：只要出现任何 Markdown / 公式迹象就走 WebView）
    static func canRenderNatively(_ s: String) -> Bool {
        guard !s.isEmpty else { return true }
        guard liveCount < 14 else { return false }   // 安全阀
        if s.contains("$") || s.contains("\\(") || s.contains("\\[") { return false }
        let signals = ["```", "**", "__", "`", "|", "#", ">", "* ", "- ", "+ ", "](", "~~"]
        return !signals.contains { s.contains($0) }
    }
}

struct MarkdownWebView: NSViewRepresentable {
    let text: String
    var isUserInput: Bool = false
    var fontSize: CGFloat = 14
    @ObservedObject var heightBox: RichTextHeightBox

    func makeNSView(context: Context) -> WKWebView {
        RichText.createdCount += 1
        RichText.liveCount += 1
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(context.coordinator, name: "height")
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.setValue(false, forKey: "drawsBackground")
        wv.navigationDelegate = context.coordinator
        context.coordinator.webView = wv
        let base: URL
        if let u = URL(string: APIClient.shared.baseURL) { base = u } else { base = URL(string: "http://localhost:8765")! }
        let html = Self.html(base: base.absoluteString, fontSize: fontSize, isUserInput: isUserInput)
        wv.loadHTMLString(html, baseURL: base)
        context.coordinator.pendingText = text
        // 页面就绪后渲染初始文本
        context.coordinator.scheduleRender(text: text, force: true)
        return wv
    }

    func updateNSView(_ wv: WKWebView, context: Context) {
        context.coordinator.fontSize = fontSize
        context.coordinator.isUserInput = isUserInput
        if text != context.coordinator.lastText {
            context.coordinator.scheduleRender(text: text)
        }
    }

    /// 视图销毁时必须主动拆干净。
    /// userContentController 会**强引用** scriptMessageHandler（coordinator），
    /// 若 coordinator 又强引用 webView，就成了循环引用 —— WKWebView 永不释放，
    /// 每个残留的 webview 都带着一个 WebContent 进程，进程数只涨不降。
    static func dismantleNSView(_ wv: WKWebView, coordinator: Coordinator) {
        coordinator.dispose()
        RichText.liveCount = max(0, RichText.liveCount - 1)
    }

    func makeCoordinator() -> Coordinator { Coordinator(heightBox: heightBox) }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let heightBox: RichTextHeightBox
        weak var webView: WKWebView?      // 弱引用：生命周期交给 SwiftUI
        var lastText = "\u{0}"          // 与首个文本必不相同
        var pendingText: String?
        var renderTask: DispatchWorkItem?
        var lastRenderAt = Date.distantPast
        var fontSize: CGFloat = 14
        var isUserInput = false

        init(heightBox: RichTextHeightBox) { self.heightBox = heightBox }

        func dispose() {
            renderTask?.cancel()
            renderTask = nil
            pendingText = nil
            webView?.configuration.userContentController.removeScriptMessageHandler(forName: "height")
            webView?.stopLoading()
            webView?.navigationDelegate = nil
            webView = nil
        }

        /// 与 Web 端 `__set([text, isUserInput])` 对齐：编码成两元数组
        private struct Payload: Encodable {
            let text: String
            let user: Bool
            func encode(to encoder: Encoder) throws {
                var c = encoder.unkeyedContainer()
                try c.encode(text)
                try c.encode(user)
            }
        }

        func scheduleRender(text: String, force: Bool = false) {
            pendingText = text
            renderTask?.cancel()
            // 流式输出节流：80ms 内只渲一次（等价 Web 端的 rAF 节流）
            let wait: TimeInterval = force ? 0 : max(0, 0.08 - Date().timeIntervalSince(lastRenderAt))
            let task = DispatchWorkItem { [weak self] in self?.renderNow() }
            renderTask = task
            DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: task)
        }

        func renderNow() {
            guard let wv = webView, let text = pendingText else { return }
            pendingText = nil
            lastText = text
            lastRenderAt = Date()
            let payload: String
            if let data = try? JSONEncoder().encode(Payload(text: text, user: isUserInput)) {
                payload = String(data: data, encoding: .utf8) ?? "[\"\"]"
            } else { payload = "[\"\"]" }
            wv.evaluateJavaScript("__set(\(payload))", completionHandler: nil)
        }

        /// 页面脚本（marked / KaTeX）加载完成后补渲一次。
        /// loadHTMLString 之后立刻 evaluateJavaScript，`__set` 往往还没定义 —— 静默失败，卡片会空白。
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard lastText != "\u{0}" else { return }
            pendingText = lastText
            renderNow()
        }

        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {            if message.name == "height", let h = message.body as? NSNumber {
                let v = CGFloat(truncating: h)
                if abs(v - heightBox.height) > 0.5 {
                    DispatchQueue.main.async { self.heightBox.height = v }
                }
            }
        }
    }

    static func html(base: String, fontSize: CGFloat, isUserInput: Bool) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8">
        <link rel="stylesheet" href="\(base)/vendor/katex/katex.min.css">
        <script src="\(base)/vendor/marked/marked.min.js"></script>
        <script src="\(base)/vendor/katex/katex.min.js"></script>
        <script src="\(base)/vendor/katex/contrib/auto-render.min.js"></script>
        <style>
          html,body{margin:0;padding:0;background:transparent;
            font-family:-apple-system,"PingFang SC","Helvetica Neue",sans-serif;
            font-size:\(Int(fontSize))px;line-height:1.65;color:#1f2937;
            word-break:break-word;overflow:hidden;}
          img{max-width:100%;border-radius:8px;}
          pre{background:#f3f4f6;padding:8px 10px;border-radius:8px;overflow-x:auto;font-size:12px;}
          code{font-family:ui-monospace,Menlo,monospace;background:#f3f4f6;padding:1px 4px;border-radius:4px;font-size:12.5px;}
          pre code{background:none;padding:0;}
          table{border-collapse:collapse;margin:6px 0;}
          td,th{border:1px solid #e5e7eb;padding:4px 8px;}
          blockquote{border-left:3px solid #c7d2fe;margin:6px 0;padding:2px 10px;color:#4b5563;}
          ul,ol{padding-left:20px;margin:4px 0;}
          .katex-display{margin:6px 0;overflow-x:auto;}
        </style></head>
        <body><div id="c"></div>
        <script>
        var __raw='';
        function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
        function renderNow(){
          var el=document.getElementById('c');
          var src=__raw;
          try{
            if(window.marked){ el.innerHTML=marked.parse(src); }
            else{ el.innerHTML='<pre>'+esc(src)+'</pre>'; }
          }catch(e){ el.textContent=src; }
          if(window.renderMathInElement){
            try{
              renderMathInElement(el,{delimiters:[
                {left:'$$',right:'$$',display:true},
                {left:'$',right:'$',display:false}
              ],throwOnError:false});
            }catch(e){}
          }
          setTimeout(function(){
            try{webkit.messageHandlers.height.postMessage(document.body.scrollHeight);}catch(e){}
          },30);
        }
        function __set(pair){
          __raw = pair[1] ? esc(pair[0]) : pair[0];
          renderNow();
        }
        </script>
        </body></html>
        """
    }
}

// MARK: - 通用 WebView（分步作图 iframe 用）

struct WebViewRep: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> WKWebView {
        let wv = WKWebView()
        wv.load(URLRequest(url: url))
        return wv
    }
    func updateNSView(_ wv: WKWebView, context: Context) {}
}
