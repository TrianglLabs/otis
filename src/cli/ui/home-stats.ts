import type { TextRenderable } from "@opentui/core"
import type { LocalStats } from "../../local/stats.js"
import { formatStats, formatTokenCount } from "./format.js"
import { ACTIVITY_DAYS, activityArt } from "./panels.js"
import type { Renderer } from "./types.js"

const STAT_COUNT_DURATION_MS = 900
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
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
  cachedPromptTokens: 0,
  cacheReportedPromptTokens: 0,
  todayTokens: 0,
  recentActivity: [],
  modelUsage: {},
  achievements: {},
}

type HomeStatsOptions = {
  renderer: Renderer
  statBoxes: { value: TextRenderable; label: TextRenderable }[]
  chart: TextRenderable
  range: TextRenderable
  today: TextRenderable
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

  /** Repaints the chart in the current theme colours. */
  refreshTheme() {
    this.paint("rest")
  }

  private paint(elapsedOrRest: number | "rest") {
    const { statBoxes, chart, range, today } = this.options
    const lastStart = STAT_COUNT_STAGGER_MS * (statBoxes.length - 1)
    for (let index = 0; index < statBoxes.length; index += 1) {
      const amount =
        elapsedOrRest === "rest"
          ? 1
          : easeOutCubic(progress(elapsedOrRest, index * STAT_COUNT_STAGGER_MS))
      const items = formatStats(interpolateStats(this.from, this.to, amount))
      statBoxes[index].value.content = items[index].value
      statBoxes[index].label.content = items[index].label
    }
    // Bars grow left to right across the same window as the cards.
    const activity = this.to.recentActivity
    const grown = Array.from({ length: ACTIVITY_DAYS }, (_, day) =>
      elapsedOrRest === "rest"
        ? 1
        : easeOutCubic(progress(elapsedOrRest, (lastStart * day) / (ACTIVITY_DAYS - 1))),
    )
    chart.content = activityArt(activity, grown)
    // `Sep 25 – Oct 22`: the first and last charted day, blank with no history.
    const first = activity[0]
    const last = activity.at(-1)
    range.content = first && last ? `${shortDate(first.date)} – ${shortDate(last.date)}` : ""
    today.content = `today ${formatTokenCount(this.to.todayTokens)}`
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

function shortDate(date: string) {
  const [year, month, day] = date.split("-").map(Number)
  return SHORT_DATE.format(new Date(year, month - 1, day))
}

function easeOutCubic(amount: number) {
  const t = clamp(amount, 0, 1)
  return 1 - (1 - t) ** 3
}

function progress(elapsedMs: number, startMs: number) {
  return clamp((elapsedMs - startMs) / STAT_COUNT_DURATION_MS, 0, 1)
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
