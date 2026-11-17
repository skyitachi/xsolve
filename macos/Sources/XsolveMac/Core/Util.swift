import AppKit
import Foundation
import SwiftUI

// MARK: - 时间

func fmtDate(_ ts: Double?) -> String {
    guard let ts, ts > 0 else { return "—" }
    let d = Date(timeIntervalSince1970: ts)
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_CN")
    f.dateFormat = "MM-dd HH:mm"
    return f.string(from: d)
}

func fmtDay(_ ts: Double?) -> String {
    guard let ts, ts > 0 else { return "—" }
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_CN")
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: Date(timeIntervalSince1970: ts))
}

func fmtDuration(_ ms: Int?) -> String {
    guard let ms else { return "—" }
    let s = ms / 1000
    if s < 60 { return "\(s)s" }
    return "\(s / 60)m\(s % 60)s"
}

// MARK: - 图片 ↔ DataURL

enum ImageUtil {
    /// 等比缩放到长边不超过 maxEdge，输出 JPEG dataURL（与 Web 端 downscaleDataUrl 对齐）
    static func jpegDataURL(from image: NSImage, maxEdge: CGFloat, quality: CGFloat = 0.9) -> String? {
        let size = image.size
        guard size.width > 1, size.height > 1 else { return nil }
        var w = size.width, h = size.height
        if w > maxEdge || h > maxEdge {
            let r = min(maxEdge / w, maxEdge / h)
            w = (w * r).rounded()
            h = (h * r).rounded()
        }
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(w), pixelsHigh: Int(h),
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = NSSize(width: w, height: h)
        let ctx = NSGraphicsContext(bitmapImageRep: rep)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        NSColor.white.setFill()  // 打底白，避免透明 PNG 压成 JPEG 后发黑
        ctx?.cgContext.fill(CGRect(x: 0, y: 0, width: w, height: h))
        image.draw(in: NSRect(x: 0, y: 0, width: w, height: h))
        NSGraphicsContext.restoreGraphicsState()
        guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]) else { return nil }
        return "data:image/jpeg;base64," + data.base64EncodedString()
    }

    static func jpegDataURL(from data: Data, maxEdge: CGFloat) -> String? {
        guard let img = NSImage(data: data) else { return nil }
        return jpegDataURL(from: img, maxEdge: maxEdge)
    }

    /// dataURL → (mediaType, base64)；不合法返回 nil
    static func parseDataURL(_ s: String) -> (mediaType: String, base64: String)? {
        guard let r = s.range(of: "base64,") else { return nil }
        let head = String(s[..<r.lowerBound])  // "data:image/jpeg;"
        let media = head.replacingOccurrences(of: "data:", with: "")
            .replacingOccurrences(of: ";", with: "")
        return (media.isEmpty ? "image/jpeg" : media, String(s[r.upperBound...]))
    }

    static func image(fromDataURL s: String) -> NSImage? {
        guard let parts = parseDataURL(s), let d = Data(base64Encoded: parts.base64) else { return nil }
        return NSImage(data: d)
    }
}

// MARK: - 裁剪

struct CropRect: Equatable {
    // Web 端（crop.js）首次进入默认框住中间 88%，留出可见边距提示「可以拖」
    var x: CGFloat = 0.06, y: CGFloat = 0.06, w: CGFloat = 0.88, h: CGFloat = 0.88  // 归一化 0~1
}

/// 按归一化裁剪框裁剪图片，输出 JPEG dataURL
enum Cropper {
    static func crop(image: NSImage, rect: CropRect, maxEdge: CGFloat = 1600, quality: CGFloat = 0.9) -> String? {
        let size = image.size
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        // NSImage 坐标系原点在左下；CGImage 在上左。先算像素框
        let pxW = CGFloat(cg.width), pxH = CGFloat(cg.height)
        let sx = CGFloat(cg.width) / size.width, sy = CGFloat(cg.height) / size.height
        var cropX = rect.x * pxW
        var cropY = rect.y * pxH
        var cropW = rect.w * pxW
        var cropH = rect.h * pxH
        cropX = max(0, min(cropX, pxW - 2))
        cropY = max(0, min(cropY, pxH - 2))
        cropW = max(2, min(cropW, pxW - cropX))
        cropH = max(2, min(cropH, pxH - cropY))
        _ = sx; _ = sy
        guard let sub = cg.cropping(to: CGRect(x: cropX, y: cropY, width: cropW, height: cropH)) else { return nil }
        let out = NSImage(cgImage: sub, size: NSSize(width: sub.width, height: sub.height))
        return ImageUtil.jpegDataURL(from: out, maxEdge: maxEdge, quality: quality)
    }
}

// MARK: - 十六进制色

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
    static let brand = Color(hex: 0x4F46E5)
    static let paperBG = Color(hex: 0xFFFEF6)
}

// MARK: - 复制到剪贴板 / 打开链接

func copyToPasteboard(_ s: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(s, forType: .string)
}

func openInBrowser(_ url: URL) {
    NSWorkspace.shared.open(url)
}
