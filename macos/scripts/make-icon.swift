// 生成 macOS 应用图标（AppIcon.icns）
//
// 用法：swift scripts/make-icon.swift
// 产物：Resources/AppIcon.icns、Resources/AppIcon.iconset/*、Resources/AppIcon-1024.png
//
// 设计说明（与 Web 端品牌一致，但按 macOS 规范重绘）：
// - 造型用超椭圆（squircle），不是 Web 的普通圆角矩形 —— macOS Big Sur 之后系统图标统一如此
// - 内容区 824/1024 留白 + 投影，符合 Apple 图标网格；直接铺满会被 Dock 里其他图标压住
// - 主色沿用品牌渐变 #5B4FF0 → #3B2FD0，中心青色 #27D2BF 圆点保留
// - × 读作乘号（数学），不是 UI 的「关闭」；圆点是「答案 / 启发点」
// - 每一档尺寸都从矢量重绘，不做位图缩放，保证 16px 下笔画仍清晰

import AppKit
import CoreGraphics
import Foundation

let canvas: CGFloat = 1024
let outRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let resDir = outRoot.appendingPathComponent("Resources")
let iconsetDir = resDir.appendingPathComponent("AppIcon.iconset")

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(
        srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: alpha
    )
}

/// 超椭圆路径：|x/a|^n + |y/b|^n = 1，n ≈ 5 接近 Apple 的连续圆角
func squircle(centerX: CGFloat, centerY: CGFloat, half: CGFloat, n: CGFloat = 5) -> CGPath {
    let p = CGMutablePath()
    let steps = 720
    for i in 0...steps {
        let t = CGFloat(i) / CGFloat(steps) * .pi * 2
        let ct = cos(t), st = sin(t)
        let x = centerX + half * copysign(pow(abs(ct), 2 / n), ct)
        let y = centerY + half * copysign(pow(abs(st), 2 / n), st)
        if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
    }
    p.closeSubpath()
    return p
}

/// 圆头线段的填充路径（胶囊形）：先按线宽外扩半个圆帽，再做圆角矩形
func roundedLine(from a: CGPoint, to b: CGPoint, width: CGFloat) -> CGPath {
    let r = width / 2
    let dx = b.x - a.x, dy = b.y - a.y
    let len = (dx * dx + dy * dy).squareRoot()
    let angle = atan2(dy, dx)
    let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
    let rect = CGRect(x: -len / 2 - r, y: -r, width: len + width, height: width)
    var t = CGAffineTransform(translationX: mid.x, y: mid.y).rotated(by: angle)
    return CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: &t)
}

/// 在 size×size 的位图上绘制；所有坐标按 1024 设计稿等比缩放
func drawIcon(size: Int) -> CGImage? {
    guard let ctx = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    let s = CGFloat(size) / canvas
    ctx.scaleBy(x: s, y: s)
    ctx.setAllowsAntialiasing(true)
    ctx.interpolationQuality = .high

    // —— 主体：824 见方，居中，Apple 图标网格留白 ——
    let inset: CGFloat = 100
    let side = canvas - inset * 2
    let body = squircle(centerX: canvas / 2, centerY: canvas / 2, half: side / 2)

    // 投影（macOS 图标的标志性悬浮感）
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 30,
                  color: color(0x14103A, 0.30))
    ctx.addPath(body)
    ctx.setFillColor(color(0x4A3BE0))
    ctx.fillPath()
    ctx.restoreGState()

    // 渐变底色
    ctx.saveGState()
    ctx.addPath(body)
    ctx.clip()
    let gradient = CGGradient(
        colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [color(0x7A69FF), color(0x5B4FF0), color(0x3B2FD0)] as CFArray,
        locations: [0, 0.5, 1]
    )!
    ctx.drawLinearGradient(
        gradient,
        start: CGPoint(x: inset, y: inset + side),          // 左上
        end: CGPoint(x: inset + side, y: inset),            // 右下
        options: []
    )

    // 顶部高光（只在顶部 40% 之内，避免整块发白）
    let gloss = CGGradient(
        colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [color(0xFFFFFF, 0.16), color(0xFFFFFF, 0)] as CFArray,
        locations: [0, 1]
    )!
    ctx.drawLinearGradient(
        gloss,
        start: CGPoint(x: canvas / 2, y: canvas - inset),
        end: CGPoint(x: canvas / 2, y: canvas - inset - side * 0.42),
        options: []
    )

    // 底部轻压暗，做出厚度（线性，不用径向 —— 径向会在四角留下脏晕）
    let shade = CGGradient(
        colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [color(0x2A1FA8, 0), color(0x2A1FA8, 0.20)] as CFArray,
        locations: [0, 1]
    )!
    ctx.drawLinearGradient(
        shade,
        start: CGPoint(x: canvas / 2, y: inset + side * 0.52),
        end: CGPoint(x: canvas / 2, y: inset),
        options: []
    )
    ctx.restoreGState()

    // 内描边（一层细白边，让边缘在浅色背景上也立得住）
    ctx.saveGState()
    ctx.addPath(body)
    ctx.setStrokeColor(color(0xFFFFFF, 0.16))
    ctx.setLineWidth(2.5)
    ctx.strokePath()
    ctx.restoreGState()

    // —— 标记：× 与中心点 ——
    let arm: CGFloat = 182          // × 半臂长
    let thickness: CGFloat = 116
    let c = CGPoint(x: canvas / 2, y: canvas / 2)

    let cross = CGMutablePath()
    cross.addPath(roundedLine(from: CGPoint(x: c.x - arm, y: c.y - arm),
                              to: CGPoint(x: c.x + arm, y: c.y + arm), width: thickness))
    cross.addPath(roundedLine(from: CGPoint(x: c.x - arm, y: c.y + arm),
                              to: CGPoint(x: c.x + arm, y: c.y - arm), width: thickness))

    // 青色光晕画在笔画**下面**，否则会把白色釉成青的
    // 小尺寸（≤32px）关掉：那点光晕只会糊成一团青雾，反而降低对比
    let dotR: CGFloat = 82
    if size > 32 {
        let glow = CGGradient(
            colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            colors: [color(0x27D2BF, 0.30), color(0x27D2BF, 0.08), color(0x27D2BF, 0)] as CFArray,
            locations: [0.5, 0.8, 1]
        )!
        ctx.drawRadialGradient(
            glow,
            startCenter: c, startRadius: 0,
            endCenter: c, endRadius: dotR * 2.2,
            options: []
        )
    }

    // 标记投影：让小尺寸下也有层次
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -8), blur: 16, color: color(0x1B1580, 0.28))
    ctx.addPath(cross)
    ctx.setFillColor(color(0xFFFFFF))
    ctx.fillPath()
    ctx.restoreGState()

    // 中心青色点：径向渐变球感，不再加硬高光（1024 下会看成空心圆）
    let dotGrad = CGGradient(
        colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [color(0x46E6D2), color(0x27D2BF), color(0x14B7A6)] as CFArray,
        locations: [0, 0.55, 1]
    )!
    ctx.saveGState()
    let dotRect = CGRect(x: c.x - dotR, y: c.y - dotR, width: dotR * 2, height: dotR * 2)
    ctx.addEllipse(in: dotRect)
    ctx.clip()
    ctx.drawRadialGradient(
        dotGrad,
        startCenter: CGPoint(x: c.x - dotR * 0.34, y: c.y + dotR * 0.34), startRadius: 0,
        endCenter: c, endRadius: dotR * 1.15,
        options: []
    )
    ctx.restoreGState()

    return ctx.makeImage()
}

func write(_ image: CGImage, to url: URL) throws {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "icon", code: 1)
    }
    try data.write(to: url)
}

try? FileManager.default.createDirectory(at: iconsetDir, withIntermediateDirectories: true)

// iconset 需要的 10 个尺寸
let variants: [(Int, String)] = [
    (16, "icon_16x16"), (32, "icon_16x16@2x"),
    (32, "icon_32x32"), (64, "icon_32x32@2x"),
    (128, "icon_128x128"), (256, "icon_128x128@2x"),
    (256, "icon_256x256"), (512, "icon_256x256@2x"),
    (512, "icon_512x512"), (1024, "icon_512x512@2x"),
]

var cache: [Int: CGImage] = [:]
for (px, name) in variants {
    let img: CGImage
    if let hit = cache[px] { img = hit } else {
        guard let made = drawIcon(size: px) else { throw NSError(domain: "icon", code: 2) }
        cache[px] = made
        img = made
    }
    try write(img, to: iconsetDir.appendingPathComponent("\(name).png"))
}

if let big = drawIcon(size: 1024) {
    try write(big, to: resDir.appendingPathComponent("AppIcon-1024.png"))
}

print("iconset 已生成：\(iconsetDir.path)")
