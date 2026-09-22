import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { readSessionEvents, type SessionEvent } from "../storage/session-events.js"
import { sessionRootDirectory } from "../storage/session-files.js"

export type LocalStats = {
  streak: number
  totalTokens: number
  sessionCount: number
  avgTokensPerSession: number
  avgSessionSeconds: number
  activeDays: number
  promptTokens: number
  completionTokens: number
  recentActivity: LocalUsageDay[]
}

type LocalUsageDay = {
  date: string
  tokens: number
}

type LocalStatsOptions = {
  sessionsRoot?: string
  now?: Date
}

const ACTIVITY_EVENTS = new Set([
  "prompt_admitted",
  "prompt_steered",
  "turn_started",
  "usage_recorded",
  "turn_completed",
  "turn_interrupted",
])

export async function calculateLocalStats(options: LocalStatsOptions = {}): Promise<LocalStats> {
  const now = options.now ?? new Date()
  const root = options.sessionsRoot ?? sessionRootDirectory()
  const files: string[] = []
  for (const entry of await readDirectory(root)) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path)
    if (!entry.isDirectory()) continue
    for (const child of await readDirectory(path)) {
      if (child.isFile() && child.name.endsWith(".jsonl")) files.push(join(path, child.name))
    }
  }
  const sessions = await Promise.all(
    files.map((path) => readSessionEvents(path).catch((): SessionEvent[] => [])),
  )

  let totalTokens = 0
  let promptTokens = 0
  let completionTokens = 0
  let totalDurationSeconds = 0
  let sessionCount = 0
  const days = new Set<string>()
  const dailyTokens = new Map<string, number>()
  for (const events of sessions) {
    if (!events.some((event) => event.type === "prompt_admitted")) continue
    sessionCount += 1
    // Older sessions only recorded admission. Keep those estimates readable, but prefer
    // actual starts so queued prompts do not contribute waiting time.
    const started = new Map<string, { start: number; exact: boolean }>()
    const intervals: { start: number; end: number; exact: boolean }[] = []
    for (const event of events) {
      const at = timestamp(event.at)
      if (at !== undefined && ACTIVITY_EVENTS.has(event.type)) days.add(localDateKey(new Date(at)))
      if (event.type === "usage_recorded") {
        totalTokens += event.usage.totalTokens
        promptTokens += event.usage.promptTokens
        completionTokens += event.usage.completionTokens
        if (at === undefined) continue
        const key = localDateKey(new Date(at))
        dailyTokens.set(key, (dailyTokens.get(key) ?? 0) + event.usage.totalTokens)
      } else if (event.type === "prompt_admitted" || event.type === "turn_started") {
        if (at !== undefined)
          started.set(event.promptId, { start: at, exact: event.type === "turn_started" })
      } else if (event.type === "turn_completed" || event.type === "turn_interrupted") {
        const turn = started.get(event.promptId)
        started.delete(event.promptId)
        if (turn !== undefined && at !== undefined && at >= turn.start)
          intervals.push({ ...turn, end: at })
      }
    }
    // Merge overlapping intervals in a session, including old queued admissions, so
    // the same wall-clock time is never counted twice. Idle gaps stay excluded.
    let through = -Infinity
    let milliseconds = 0
    for (const { start, end, exact } of intervals.sort((a, b) => a.start - b.start)) {
      milliseconds += Math.max(0, end - Math.max(start, through))
      through = Math.max(through, end)
      // Count every local calendar day touched by a recorded run, including midnight
      // crossings with no intermediate usage report. Never fill gaps from estimated starts.
      if (!exact) continue
      const cursor = new Date(start)
      cursor.setHours(0, 0, 0, 0)
      for (; cursor.getTime() <= end; cursor.setDate(cursor.getDate() + 1))
        days.add(localDateKey(cursor))
    }
    totalDurationSeconds += milliseconds / 1000
  }

  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!days.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  for (; days.has(localDateKey(cursor)); cursor.setDate(cursor.getDate() - 1)) streak += 1

  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 27)
  const recentActivity = Array.from({ length: 28 }, () => {
    const date = localDateKey(day)
    day.setDate(day.getDate() + 1)
    return { date, tokens: dailyTokens.get(date) ?? 0 }
  })
  return {
    streak,
    totalTokens,
    sessionCount,
    avgTokensPerSession: sessionCount === 0 ? 0 : totalTokens / sessionCount,
    avgSessionSeconds: sessionCount === 0 ? 0 : totalDurationSeconds / sessionCount,
    activeDays: days.size,
    promptTokens,
    completionTokens,
    recentActivity,
  }
}

async function readDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return []
    throw error
  }
}

function localDateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
}

function timestamp(value: string | undefined) {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
