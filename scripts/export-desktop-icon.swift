import AppKit

func fail(_ message: String) -> Never {
    fputs("\(message)\n", stderr)
    exit(1)
}

guard CommandLine.arguments.count == 3 else {
    fail("Usage: export-desktop-icon.swift <compiled resource bundle> <output iconset>")
}
guard let bundle = Bundle(path: CommandLine.arguments[1]),
      let image = bundle.image(forResource: "Otis"),
      let appearance = NSAppearance(named: .aqua) else {
    fail("Unable to load the compiled Otis icon.")
}
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)

// Render Apple's legacy artwork, including its mask and padding, at each required size.
// The ICNS emitted by actool alone only contains the smaller representations.
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
            fail("Unable to create the \(pixels)-pixel icon bitmap.")
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        appearance.performAsCurrentDrawingAppearance {
            image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels),
                       from: .zero, operation: .copy, fraction: 1)
        }
        NSGraphicsContext.restoreGraphicsState()
        guard let center = bitmap.colorAt(x: pixels / 2, y: pixels / 2), center.alphaComponent > 0 else {
            fail("The catalog produced an empty \(pixels)-pixel icon. Compile with a pre-Tahoe deployment target.")
        }
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            fail("Unable to encode the \(pixels)-pixel icon.")
        }
        let suffix = scale == 2 ? "@2x" : ""
        try png.write(to: output.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
