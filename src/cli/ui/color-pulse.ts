import { RGBA, rgbToHex } from "@opentui/core"
import { colors } from "../theme.js"
import type { Renderer } from "./types.js"

export const COLOR_PULSE_PERIOD_MS = 2400
export const COLOR_PULSE_FRAME_MS = 50

export function colorPulseAmount(elapsedMs: number) {
  const phase = wrap(elapsedMs / COLOR_PULSE_PERIOD_MS)
  return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2)
}

const OUTLINE_REST = 0.42
const OUTLINE_PEAK = 1

export function selectionOutline(amount: number) {
  const mix = OUTLINE_REST + (OUTLINE_PEAK - OUTLINE_REST) * clamp(amount, 0, 1)
  return mix >= OUTLINE_PEAK ? colors.accent : mixHex(colors.surface, colors.accent, mix)
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

function wrap(value: number) {
  return ((value % 1) + 1) % 1
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
