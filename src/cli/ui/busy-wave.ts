import { fg, RGBA, rgbToHex, StyledText } from "@opentui/core"

const MIN_WIDTH = 16
const GLYPH = "━"
const CELLS_PER_SECOND = 28
const COLOR_STEPS = 18
const PULSE_MIN_SIGMA = 3.2
const PULSE_WIDTH = 0.07
const ECHO_SIGMA_SCALE = 1.55
const ECHO_OFFSET = 0.5
const ECHO_STRENGTH = 0.38
const BASE_INTENSITY = 0.1

export function renderBusyWave(elapsedMs: number, width: number, accent: string, background: string, label?: string) {
  const bar = busyWave(elapsedMs, width, label)
  return styleBusyWave(bar.text, bar.intensities, accent, background)
}

export function busyWave(elapsedMs: number, width: number, label?: string) {
  // Layout width can be NaN on the first frame before yoga measures the bar.
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : MIN_WIDTH
  const intensities = waveIntensities(elapsedMs, safeWidth)
  let text = GLYPH.repeat(safeWidth)
  if (!label) return { text, intensities }

  const overlay = overlayLabel(safeWidth, label)
  text = `${text.slice(0, overlay.start)}${overlay.text}${text.slice(overlay.start + overlay.length)}`
  text = text.length > safeWidth ? text.slice(0, safeWidth) : text.padEnd(safeWidth)
  for (let index = 0; index < overlay.length; index += 1) intensities[overlay.start + index] = 1
  return { text, intensities }
}

function overlayLabel(width: number, label: string) {
  const text = ` ${label} `
  if (text.length >= width) return { text: text.slice(0, width), start: 0, length: width }
  return {
    text,
    start: Math.floor((width - text.length) / 2),
    length: text.length,
  }
}

function waveIntensities(elapsedMs: number, width: number) {
  const sigma = Math.max(PULSE_MIN_SIGMA, width * PULSE_WIDTH)
  const position = wrap((elapsedMs / 1000) * CELLS_PER_SECOND, width)
  const trail = wrap(position + width * ECHO_OFFSET, width)
  const intensities: number[] = []

  for (let index = 0; index < width; index += 1) {
    const peak = gaussian(circularDistance(index, position, width), sigma)
    const echo = gaussian(circularDistance(index, trail, width), sigma * ECHO_SIGMA_SCALE) * ECHO_STRENGTH
    intensities.push(clamp(BASE_INTENSITY + (1 - BASE_INTENSITY) * peak + echo, 0, 1))
  }

  return intensities
}

function styleBusyWave(text: string, intensities: number[], accent: string, background: string) {
  if (text.length === 0) return text
  const chunks = []
  let start = 0
  let level = colorStep(intensities[0] ?? 0)
  for (let index = 1; index <= text.length; index += 1) {
    const next = index < text.length ? colorStep(intensities[index] ?? 0) : -1
    if (next === level) continue
    chunks.push(fg(mixHex(background, accent, level / (COLOR_STEPS - 1)))(text.slice(start, index)))
    start = index
    level = next
  }
  return new StyledText(chunks)
}

function gaussian(distance: number, sigma: number) {
  return Math.exp(-(distance * distance) / (2 * sigma * sigma))
}

function circularDistance(left: number, right: number, period: number) {
  const delta = Math.abs(left - right) % period
  return Math.min(delta, period - delta)
}

function wrap(value: number, period: number) {
  return ((value % period) + period) % period
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function colorStep(intensity: number) {
  return Math.round(clamp(intensity, 0, 1) * (COLOR_STEPS - 1))
}

function mixHex(from: string, to: string, amount: number) {
  const start = RGBA.fromHex(from).toInts()
  const end = RGBA.fromHex(to).toInts()
  const t = clamp(amount, 0, 1)
  return rgbToHex(
    RGBA.fromInts(
      Math.round(start[0] + (end[0] - start[0]) * t),
      Math.round(start[1] + (end[1] - start[1]) * t),
      Math.round(start[2] + (end[2] - start[2]) * t),
    ),
  )
}
