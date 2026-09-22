import type { TextRenderable } from "@opentui/core"
import type { LocalStats } from "../../local/stats.js"
import { formatStats } from "./format.js"
import type { Renderer } from "./types.js"

const STAT_COUNT_DURATION_MS = 900
const STAT_COUNT_STAGGER_MS = 70
const STAT_COUNT_FRAME_MS = 50

const ZERO_STATS: LocalStats = {
  streak: 0,
  totalTokens: 0,
  sessionCount: 0,
  avgTokensPerSession: 0,
  avgSessionSeconds: 0,
  activeDays: 0,
  promptTokens: 0,
  completionTokens: 0,
  recentActivity: [],
}

type HomeStatsOptions = {
  renderer: Renderer
  statBoxes: { value: TextRenderable; label: TextRenderable }[]
  isWelcomeVisible: () => boolean
}

export class HomeStats {
  private displayed = { ...ZERO_STATS }
  private from = { ...ZERO_STATS }
  private to = { ...ZERO_STATS }
  private startedAt = 0
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly options: HomeStatsOptions) {
    this.options.renderer.once("destroy", () => this.stop())
  }

  setStats(stats: LocalStats) {
    this.to = { ...stats }
    if (
      !this.options.isWelcomeVisible() ||
      sameStats(stats, ZERO_STATS) ||
      sameStats(this.displayed, stats)
    ) {
      this.snap(stats)
      return
    }
    this.from = { ...this.displayed }
    this.start()
  }

  /** Counts the cards up from zero again, e.g. when returning to the home screen. */
  replay() {
    if (!this.options.isWelcomeVisible() || sameStats(this.to, ZERO_STATS)) return
    this.from = { ...ZERO_STATS }
    this.start()
  }

  settle() {
    this.snap(this.to)
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  private start() {
    this.stop()
    this.startedAt = Date.now()
    this.timer = setInterval(() => this.tick(), STAT_COUNT_FRAME_MS)
    this.timer.unref?.()
    this.tick()
  }

  private snap(stats: LocalStats) {
    this.stop()
    this.displayed = { ...stats }
    this.from = { ...stats }
    this.to = { ...stats }
    this.paint("rest")
  }

  private tick() {
    const elapsed = Date.now() - this.startedAt
    const lastStart = STAT_COUNT_STAGGER_MS * (this.options.statBoxes.length - 1)
    this.displayed = interpolateStats(this.from, this.to, easeOutCubic(progress(elapsed, 0)))
    this.paint(elapsed)
    if (elapsed >= lastStart + STAT_COUNT_DURATION_MS) this.stop()
  }

  private paint(elapsedOrRest: number | "rest") {
    for (let index = 0; index < this.options.statBoxes.length; index += 1) {
      const amount = elapsedOrRest === "rest" ? 1 : easeOutCubic(progress(elapsedOrRest, index))
      const items = formatStats(interpolateStats(this.from, this.to, amount))
      const card = this.options.statBoxes[index]
      card.value.content = items[index].value
      card.label.content = items[index].label
    }
    this.options.renderer.requestRender()
  }
}

function interpolateStats(from: LocalStats, to: LocalStats, amount: number) {
  return {
    ...to,
    streak: Math.round(lerp(from.streak, to.streak, amount)),
    totalTokens: Math.round(lerp(from.totalTokens, to.totalTokens, amount)),
    sessionCount: Math.round(lerp(from.sessionCount, to.sessionCount, amount)),
    avgTokensPerSession: lerp(from.avgTokensPerSession, to.avgTokensPerSession, amount),
    avgSessionSeconds: lerp(from.avgSessionSeconds, to.avgSessionSeconds, amount),
  }
}

function easeOutCubic(amount: number) {
  const t = clamp(amount, 0, 1)
  return 1 - (1 - t) ** 3
}

function progress(elapsedMs: number, index: number) {
  return clamp((elapsedMs - index * STAT_COUNT_STAGGER_MS) / STAT_COUNT_DURATION_MS, 0, 1)
}

function lerp(from: number, to: number, amount: number) {
  return from + (to - from) * amount
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function sameStats(left: LocalStats, right: LocalStats) {
  return (
    left.streak === right.streak &&
    left.totalTokens === right.totalTokens &&
    left.sessionCount === right.sessionCount &&
    left.avgTokensPerSession === right.avgTokensPerSession &&
    left.avgSessionSeconds === right.avgSessionSeconds
  )
}
