// swift-tools-version:5.9
// xsolve macOS 原生客户端（SwiftUI）
// 后端复用仓库里的 Node 服务（默认 http://localhost:8765），本包只做客户端。
import PackageDescription

let package = Package(
    name: "XsolveMac",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "XsolveMac",
            path: "Sources/XsolveMac"
        )
    ]
)
