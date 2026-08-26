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
}

export type LocalStatsOptions = {
  sessionsRoot?: string
  now?: Date
}

export async function calculateLocalStats(options: LocalStatsOptions = {}): Promise<LocalStats> {
  const files = await findSessionFiles(options.sessionsRoot ?? sessionRootDirectory())
  const sessions = await Promise.all(files.map(readValidSession))
  const activeSessions = sessions.filter((events) => events.some((event) => event.type === "prompt_admitted"))
  const totalTokens = activeSessions.reduce((sum, events) => sum + tokenUsage(events), 0)
  const totalDurationSeconds = activeSessions.reduce((sum, events) => sum + sessionDurationSeconds(events), 0)
  const sessionCount = activeSessions.length

  return {
    streak: calculateStreak(activeSessions.flatMap(activityDates), options.now ?? new Date()),
    totalTokens,
    sessionCount,
    avgTokensPerSession: sessionCount === 0 ? 0 : totalTokens / sessionCount,
    avgSessionSeconds: sessionCount === 0 ? 0 : totalDurationSeconds / sessionCount,
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

function tokenUsage(events: readonly SessionEvent[]) {
  return events.reduce((sum, event) => (event.type === "usage_recorded" ? sum + event.usage.totalTokens : sum), 0)
}

// Sum each prompt through its matching completed or interrupted turn so idle
// gaps between turns (including sessions resumed later) are not counted.
function sessionDurationSeconds(events: readonly SessionEvent[]) {
  const started = new Map<string, number>()
  let seconds = 0

  for (const event of events) {
    if (event.type === "prompt_admitted") {
      const at = timestamp(event.at)
      if (at !== undefined) started.set(event.promptId, at)
      continue
    }
    if (event.type !== "turn_completed" && event.type !== "turn_interrupted") continue
    const start = started.get(event.promptId)
    const end = timestamp(event.at)
    started.delete(event.promptId)
    if (start === undefined || end === undefined) continue
    seconds += Math.max(0, (end - start) / 1000)
  }

  return seconds
}

function activityDates(events: readonly SessionEvent[]) {
  return events
    .filter((event) => event.type === "prompt_admitted")
    .map((event) => new Date(event.at))
    .filter((date) => Number.isFinite(date.getTime()))
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
