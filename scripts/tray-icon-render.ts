import { deflateSync } from "node:zlib"
import { MARK_CELL, MARK_FACES, MARK_GRID, MARK_VIEWBOX } from "../src/desktop/renderer/mark.js"

/**
 * Renders the macOS tray template images from the shared mark geometry. Template images are pure
 * black with alpha so the menu bar tints them for both appearances. Two deliberate departures from
 * the renderer's mark: the rounded cell corners (2 viewBox units ≈ a quarter pixel) are dropped,
 * and the working variant flattens the cube to a solid silhouette with the O closed, so the state
 * change reads at menu-bar size.
 */

export type TrayIconVariant = "idle" | "working" | "alert"

/**
 * The two committed scales: points for standard displays and their 2× retina renditions. Sized so
 * the cube itself (≈85% of the viewBox height) renders at the ~18–19pt of standard menu bar
 * glyphs.
 */
export const TRAY_ICON_SIZES = {
  base: { width: 20, height: 22 },
  retina: { width: 40, height: 44 },
} as const

/**
 * Attention badge over the cube's bottom-right corner; tray-only, deliberately not part of the
 * shared mark. The solid dot leans onto the corner cell while the transparent border ring punches
 * the cube out around it, so the badge reads as sitting on the corner — separated from the logo
 * on any menu bar background. Exported so the artwork tests can assert the exact badge geometry.
 */
export const ALERT_DOT = { cx: 101, cy: 112, radius: 13, border: 5 }

/** 4×4 supersampling keeps the diagonal edges smooth at menu-bar sizes. */
const SUPERSAMPLE = 4

/**
 * The icon's alpha channel, one byte per pixel: the artwork, in template-image semantics
 * (black + alpha).
 */
export function renderTrayIconAlpha(
  size: { width: number; height: number },
  variant: TrayIconVariant,
): Uint8Array {
  const { width, height } = size
  const scale = Math.min(width / MARK_VIEWBOX.width, height / MARK_VIEWBOX.height)
  const offsetX = (width - MARK_VIEWBOX.width * scale) / 2
  const offsetY = (height - MARK_VIEWBOX.height * scale) / 2
  const solid = variant === "working"
  const faces = [
    {
      matrix: MARK_FACES.top.matrix,
      opacity: solid ? 1 : MARK_FACES.top.opacity,
      cells: MARK_FACES.top.cells,
    },
    {
      matrix: MARK_FACES.left.matrix,
      opacity: solid ? 1 : MARK_FACES.left.opacity,
      cells: MARK_FACES.left.cells,
    },
    {
      matrix: MARK_FACES.front.matrix,
      opacity: 1,
      cells: solid ? MARK_GRID : MARK_FACES.front.cells,
    },
  ]
  const alpha = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let coverage = 0
      for (let sampleY = 0; sampleY < SUPERSAMPLE; sampleY++) {
        for (let sampleX = 0; sampleX < SUPERSAMPLE; sampleX++) {
          // Map the sample into viewBox coordinates so every face matrix applies directly.
          const vx = (x + (sampleX + 0.5) / SUPERSAMPLE - offsetX) / scale
          const vy = (y + (sampleY + 0.5) / SUPERSAMPLE - offsetY) / scale
          let sample = 0
          for (const face of faces) {
            // Point-in-cell test in the face's own grid: invert the face matrix, then check the
            // 16×16 cell rects.
            const [a, b, c, d, e, f] = face.matrix
            const determinant = a * d - c * b
            const localX = (d * (vx - e) - c * (vy - f)) / determinant
            const localY = (-b * (vx - e) + a * (vy - f)) / determinant
            const covered = face.cells.some(
              ([cx, cy]) =>
                localX >= cx &&
                localX <= cx + MARK_CELL &&
                localY >= cy &&
                localY <= cy + MARK_CELL,
            )
            if (covered) sample = 1 - (1 - sample) * (1 - face.opacity)
          }
          if (variant === "alert") {
            const distanceSq = (vx - ALERT_DOT.cx) ** 2 + (vy - ALERT_DOT.cy) ** 2
            if (distanceSq <= ALERT_DOT.radius ** 2) {
              sample = 1
            } else if (distanceSq <= (ALERT_DOT.radius + ALERT_DOT.border) ** 2) {
              // The transparent border punches through the cube so the badge separates from the
              // mark.
              sample = 0
            }
          }
          coverage += sample
        }
      }
      alpha[y * width + x] = Math.round((coverage / (SUPERSAMPLE * SUPERSAMPLE)) * 255)
    }
  }
  return alpha
}

/**
 * Minimal PNG encoder: RGBA8, filter-free scanlines, node:zlib deflate. Output is deterministic,
 * so tests can verify the committed icons byte-for-byte against the generator.
 */
export function renderTrayIcon(
  size: { width: number; height: number },
  variant: TrayIconVariant,
): Buffer {
  const { width, height } = size
  const alpha = renderTrayIconAlpha(size, variant)
  const stride = width * 4
  const scanlines = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    scanlines[y * (stride + 1)] = 0 // filter type: none
    for (let x = 0; x < width; x++)
      scanlines[y * (stride + 1) + 1 + x * 4 + 3] = alpha[y * width + x]
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // color type: truecolor + alpha
  // Bytes 10–12 (deflate, adaptive filtering, no interlace) stay zero from the allocation.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, "ascii")
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, data.length + 8))
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8)
  return chunk
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let value = n
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[n] = value
  }
  return table
})()
