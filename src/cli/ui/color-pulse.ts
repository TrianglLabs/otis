import { fg, RGBA, rgbToHex, StyledText } from "@opentui/core"
import { colors } from "../theme.js"
import type { Renderer } from "./types.js"

const COLOR_PULSE_PERIOD_MS = 2400
const COLOR_PULSE_FRAME_MS = 50
const TEXT_SHIMMER_PERIOD_MS = 1300
const BUSY_WAVE_ONE_WAY_MS = 1200

const OUTLINE_REST = 0.42
const OUTLINE_PEAK = 1
const SHIMMER_SIGMA = 1.15

const WAVE_MIN_WIDTH = 16
const WAVE_GLYPH = "━"
const WAVE_COLOR_STEPS = 18
const PULSE_MIN_SIGMA = 3.2
const PULSE_WIDTH = 0.07
const ECHO_SIGMA_SCALE = 1.55
const ECHO_OFFSET = 0.16
const ECHO_STRENGTH = 0.38
const BASE_INTENSITY = 0.1

export function colorPulseAmount(elapsedMs: number) {
  const phase = wrap(elapsedMs / COLOR_PULSE_PERIOD_MS)
  return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2)
}

export function selectionOutline(amount: number) {
  const mix = OUTLINE_REST + (OUTLINE_PEAK - OUTLINE_REST) * clamp(amount, 0, 1)
  return mix >= OUTLINE_PEAK ? colors.accent : mixHex(colors.surface, colors.accent, mix)
}

export function shimmerText(
  text: string,
  elapsedMs: number,
  rest = colors.muted,
  highlight = colors.accent,
) {
  const travel = text.length + SHIMMER_SIGMA * 4
  const peak = wrap(elapsedMs / TEXT_SHIMMER_PERIOD_MS) * travel - SHIMMER_SIGMA * 2
  return new StyledText(
    Array.from(text, (character, index) =>
      fg(mixHex(rest, highlight, gaussian(index - peak, SHIMMER_SIGMA)))(character),
    ),
  )
}

/**
 * The animated busy bar: a pulse that bounces across the width, with an optional centered
 * label.
 */
export function renderBusyWave(
  elapsedMs: number,
  width: number,
  accent: string,
  background: string,
  label?: string,
) {
  // Layout width can be NaN on the first frame before yoga measures the bar.
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : WAVE_MIN_WIDTH
  const sigma = Math.max(PULSE_MIN_SIGMA, safeWidth * PULSE_WIDTH)
  const span = Math.max(1, safeWidth - 1)
  // Ping-pong the pulse across the bar instead of wrapping around.
  const cycle = safeWidth <= 1 ? 0 : wrap((elapsedMs / BUSY_WAVE_ONE_WAY_MS) * span, span * 2)
  const forward = cycle <= span
  const position = forward ? cycle : span * 2 - cycle
  const trail = clamp(
    position + (forward ? -safeWidth : safeWidth) * ECHO_OFFSET,
    0,
    Math.max(0, safeWidth - 1),
  )
  const intensities: number[] = []
  for (let index = 0; index < safeWidth; index += 1) {
    const peak = gaussian(index - position, sigma)
    const echo = gaussian(index - trail, sigma * ECHO_SIGMA_SCALE) * ECHO_STRENGTH
    intensities.push(clamp(BASE_INTENSITY + (1 - BASE_INTENSITY) * peak + echo, 0, 1))
  }
  let text = WAVE_GLYPH.repeat(safeWidth)
  if (label) {
    const padded = ` ${label} `
    const length = Math.min(padded.length, safeWidth)
    const start = padded.length >= safeWidth ? 0 : Math.floor((safeWidth - padded.length) / 2)
    text = `${text.slice(0, start)}${padded.slice(0, length)}${text.slice(start + length)}`
    for (let index = 0; index < length; index += 1) intensities[start + index] = 1
  }

  const chunks = []
  let chunkStart = 0
  let level = colorStep(intensities[0])
  for (let index = 1; index <= safeWidth; index += 1) {
    const next = index < safeWidth ? colorStep(intensities[index]) : -1
    if (next === level) continue
    const color = mixHex(background, accent, level / (WAVE_COLOR_STEPS - 1))
    chunks.push(fg(color)(text.slice(chunkStart, index)))
    chunkStart = index
    level = next
  }
  return new StyledText(chunks)
}

export class SelectionPulse {
  #timer: NodeJS.Timeout | undefined
  #startedAt = 0

  constructor(
    private readonly renderer: Renderer,
    private readonly onTick: (elapsedMs: number) => void,
  ) {
    this.renderer.once("destroy", () => this.stop())
  }

  start() {
    if (this.#timer) return
    this.#startedAt = Date.now()
    this.#timer = setInterval(() => this.tick(), COLOR_PULSE_FRAME_MS)
    this.#timer.unref?.()
    this.tick()
  }

  stop() {
    if (!this.#timer) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  elapsed() {
    return this.#timer ? Date.now() - this.#startedAt : 0
  }

  private tick() {
    this.onTick(Date.now() - this.#startedAt)
    this.renderer.requestRender()
  }
}

function gaussian(distance: number, sigma: number) {
  return Math.exp(-(distance * distance) / (2 * sigma * sigma))
}

function colorStep(intensity: number) {
  return Math.round(clamp(intensity, 0, 1) * (WAVE_COLOR_STEPS - 1))
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

function wrap(value: number, period = 1) {
  return ((value % period) + period) % period
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
