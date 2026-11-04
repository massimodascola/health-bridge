// Draws the app icon (1024x1024): white heart with heartbeat trace
// on a gradient background. Original drawing, no SF Symbols (Apple's license
// prohibits their use in icons). Usage: swift scripts/make-icon.swift <file.png>
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size: CGFloat = 1024
let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.png"

// No alpha channel: iOS icons must be opaque.
let ctx = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!

// Coordinates with origin at top-left, like vector drawings.
ctx.translateBy(x: 0, y: size)
ctx.scaleBy(x: 1, y: -1)

func color(_ hex: UInt32) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

// Background: coral to raspberry, diagonally.
let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                          colors: [color(0xFF7A59), color(0xE8265E), color(0xB0124F)] as CFArray,
                          locations: [0, 0.55, 1])!
ctx.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size, y: size), options: [])

// Heart in a 620-point box, slightly below center.
let box = CGRect(x: (size - 620) / 2, y: 225, width: 620, height: 620)
func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: box.minX + x * box.width, y: box.minY + y * box.height) }
let heart = CGMutablePath()
heart.move(to: p(0.5, 0.92))
heart.addCurve(to: p(0.04, 0.33), control1: p(0.42, 0.86), control2: p(0.04, 0.62))
heart.addCurve(to: p(0.30, 0.05), control1: p(0.04, 0.15), control2: p(0.17, 0.05))
heart.addCurve(to: p(0.5, 0.17), control1: p(0.39, 0.05), control2: p(0.46, 0.10))
heart.addCurve(to: p(0.70, 0.05), control1: p(0.54, 0.10), control2: p(0.61, 0.05))
heart.addCurve(to: p(0.96, 0.33), control1: p(0.83, 0.05), control2: p(0.96, 0.15))
heart.addCurve(to: p(0.5, 0.92), control1: p(0.96, 0.62), control2: p(0.58, 0.86))
heart.closeSubpath()

// Soft shadow under the heart.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: 18), blur: 40, color: CGColor(red: 0.35, green: 0, blue: 0.1, alpha: 0.35))
ctx.addPath(heart)
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.fillPath()
ctx.restoreGState()

// Heartbeat trace, clipped inside the heart.
let pulse = CGMutablePath()
pulse.move(to: p(0.0, 0.45))
pulse.addLine(to: p(0.30, 0.45))
pulse.addLine(to: p(0.37, 0.36))
pulse.addLine(to: p(0.45, 0.62))
pulse.addLine(to: p(0.54, 0.22))
pulse.addLine(to: p(0.62, 0.52))
pulse.addLine(to: p(0.67, 0.45))
pulse.addLine(to: p(1.0, 0.45))
ctx.saveGState()
ctx.addPath(heart)
ctx.clip()
ctx.addPath(pulse)
ctx.setStrokeColor(color(0xE8265E))
ctx.setLineWidth(40)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.strokePath()
ctx.restoreGState()

let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, ctx.makeImage()!, nil)
CGImageDestinationFinalize(destination)
print("Created \(output)")
