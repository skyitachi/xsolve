#!/bin/bash
# 把 SPM 构建产物打包成 XsolveMac.app
#
# 为什么需要 .app：语音输入（麦克风）和相机（连续互通相机）依赖 Info.plist 里的
# 用途声明；裸跑 swift run 的进程没有这些 key，申请权限会直接失败/崩溃。
# 打包后语音与相机功能才可用。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> swift build -c release"
# 某些环境（受管/沙箱）下 SPM 自身的沙箱起不来，退回 --disable-sandbox 重试
if ! swift build -c release; then
  echo "    构建失败，改用 --disable-sandbox 重试..."
  swift build -c release --disable-sandbox
fi

BIN=".build/release/XsolveMac"
APP="XsolveMac.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/XsolveMac"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>小学AI做题助手</string>
    <key>CFBundleDisplayName</key><string>小学AI做题助手</string>
    <key>CFBundleIdentifier</key><string>cn.xsolve.mac</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>XsolveMac</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSMicrophoneUsageDescription</key>
    <string>用于语音输入题目与保存录音，交给 AI 处理。</string>
    <key>NSSpeechRecognitionUsageDescription</key>
    <string>用于把语音实时转写为题目文本。</string>
    <key>NSCameraUsageDescription</key>
    <string>用于拍题（连续互通相机 / 内置摄像头）。</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <!-- 局域网部署常是 http://<内网IP> 或自签名 https，放开 ATS 限制 -->
        <key>NSAllowsArbitraryLoads</key><true/>
    </dict>
</dict>
</plist>
PLIST

echo "==> 已生成 $APP"
echo "    运行：open $APP   （或双击）"
echo "    首次启动后请在登录页设置服务器地址（默认 http://localhost:8765）"
