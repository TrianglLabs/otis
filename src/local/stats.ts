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

export type LocalUsageDay = {
  date: string
  tokens: number
}

export type LocalStatsOptions = {
  sessionsRoot?: string
  now?: Date
}

export async function calculateLocalStats(options: LocalStatsOptions = {}): Promise<LocalStats> {
  const files = await findSessionFiles(options.sessionsRoot ?? sessionRootDirectory())
  const sessions = await Promise.all(files.map(readValidSession))
  const activeSessions = sessions.filter((events) => events.some((event) => event.type === "prompt_admitted"))
  const usageEvents = activeSessions.flatMap((events) => events.filter((event) => event.type === "usage_recorded"))
  const totalTokens = usageEvents.reduce((sum, event) => sum + event.usage.totalTokens, 0)
  const intervals = activeSessions.map(turnIntervals)
  const totalDurationSeconds = intervals.reduce((sum, turns) => sum + sessionDurationSeconds(turns), 0)
  const sessionCount = activeSessions.length
  const now = options.now ?? new Date()
  const activity = activeSessions.flatMap((events, index) => activityDates(events, intervals[index]))

  return {
    streak: calculateStreak(activity, now),
    totalTokens,
    sessionCount,
    avgTokensPerSession: sessionCount === 0 ? 0 : totalTokens / sessionCount,
    avgSessionSeconds: sessionCount === 0 ? 0 : totalDurationSeconds / sessionCount,
    activeDays: new Set(activity.map(localDateKey)).size,
    promptTokens: usageEvents.reduce((sum, event) => sum + event.usage.promptTokens, 0),
    completionTokens: usageEvents.reduce((sum, event) => sum + event.usage.completionTokens, 0),
    recentActivity: recentActivityDays(usageEvents, now),
  }
}

async function findSessionFiles(root: string) {
  const entries = await readDirectory(root)
  const files: string[] = []

  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path)
    if (!entry.isDirectory()) continue
    for (const child of await readDirectory(path)) {
      if (child.isFile() && child.name.endsWith(".jsonl")) files.push(join(path, child.name))
    }
  }
  return files
}

async function readDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

async function readValidSession(path: string): Promise<SessionEvent[]> {
  try {
    return await readSessionEvents(path)
  } catch {
    return []
  }
}

type TurnInterval = { start: number; end: number; exact: boolean }

// Older sessions only recorded admission. Keep those estimates readable, but prefer
// actual starts so queued prompts do not contribute waiting time.
function turnIntervals(events: readonly SessionEvent[]): TurnInterval[] {
  const started = new Map<string, { start: number; exact: boolean }>()
  const intervals: TurnInterval[] = []

  for (const event of events) {
    if (event.type === "prompt_admitted" || event.type === "turn_started") {
      const at = timestamp(event.at)
      if (at !== undefined) started.set(event.promptId, { start: at, exact: event.type === "turn_started" })
      continue
    }
    if (event.type !== "turn_completed" && event.type !== "turn_interrupted") continue
    const turn = started.get(event.promptId)
    const end = timestamp(event.at)
    started.delete(event.promptId)
    if (turn === undefined || end === undefined || end < turn.start) continue
    intervals.push({ ...turn, end })
  }
  return intervals
}

// Merge overlapping intervals in a session, including old queued admissions, so
// the same wall-clock time is never counted twice. Idle gaps stay excluded.
function sessionDurationSeconds(intervals: readonly TurnInterval[]) {
  let through = -Infinity
  let milliseconds = 0
  for (const { start, end } of [...intervals].sort((a, b) => a.start - b.start)) {
    milliseconds += Math.max(0, end - Math.max(start, through))
    through = Math.max(through, end)
  }
  return milliseconds / 1000
}

function activityDates(events: readonly SessionEvent[], intervals: readonly TurnInterval[]) {
  const dates = events
    .filter(
      (event) =>
        event.type === "prompt_admitted" ||
        event.type === "prompt_steered" ||
        event.type === "turn_started" ||
        event.type === "usage_recorded" ||
        event.type === "turn_completed" ||
        event.type === "turn_interrupted",
    )
    .map((event) => new Date(event.at))
    .filter((date) => Number.isFinite(date.getTime()))
  // Count every local calendar day touched by a recorded run, including midnight
  // crossings with no intermediate usage report. Never fill gaps from estimated starts.
  for (const { start, end, exact } of intervals) {
    if (!exact) continue
    const cursor = new Date(start)
    cursor.setHours(0, 0, 0, 0)
    while (cursor.getTime() <= end) {
      dates.push(new Date(cursor))
      cursor.setDate(cursor.getDate() + 1)
    }
  }
  return dates
}

function recentActivityDays(
  events: readonly Extract<SessionEvent, { type: "usage_recorded" }>[],
  now: Date,
): LocalUsageDay[] {
  const totals = new Map<string, number>()
  for (const event of events) {
    const date = new Date(event.at)
    if (!Number.isFinite(date.getTime())) continue
    const key = localDateKey(date)
    totals.set(key, (totals.get(key) ?? 0) + event.usage.totalTokens)
  }

  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  cursor.setDate(cursor.getDate() - 27)
  return Array.from({ length: 28 }, () => {
    const date = localDateKey(cursor)
    const day = { date, tokens: totals.get(date) ?? 0 }
    cursor.setDate(cursor.getDate() + 1)
    return day
  })
}

function calculateStreak(activity: readonly Date[], now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("Current date is invalid.")
  const days = new Set(activity.map(localDateKey))
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  if (!days.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1)

  let streak = 0
  while (days.has(localDateKey(cursor))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

function localDateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
}

function timestamp(value: string | undefined) {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
