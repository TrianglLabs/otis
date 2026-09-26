import { existsSync } from "node:fs"
import { mkdir, readdir, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ModelProvider } from "../inference/types.js"
import { sessionRootDirectory } from "../storage/session-files.js"
import { readSessionDigest, type SessionActivity } from "../storage/session-index.js"

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

/** What Omarchy's agents panel shows beyond the home screen, from the same pass. */
type LocalUsage = {
  promptCount: number
  todayPrompts: number
  todaySessions: number
  todayTokens: number
  activeDates: string[]
  /** Every provider that served recorded usage. */
  providers: ModelProvider[]
  /**
   * Tokens by serving model id, under the picker name it was recorded with. Usage recorded before
   * models were noted is left out.
   */
  modelUsage: Record<string, { name: string; promptTokens: number; completionTokens: number }>
  todayTokensByModel: Record<string, number>
}

type LocalUsageDay = {
  date: string
  tokens: number
}

type LocalStatsOptions = {
  sessionsRoot?: string
  now?: Date
}

export async function calculateLocalStats(
  options: LocalStatsOptions = {},
): Promise<LocalStats & LocalUsage> {
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
  let totalTokens = 0
  let promptTokens = 0
  let completionTokens = 0
  let totalDurationSeconds = 0
  let sessionCount = 0
  let promptCount = 0
  let todayPrompts = 0
  let todaySessions = 0
  let todayTokens = 0
  const today = localDateKey(now)
  const days = new Set<string>()
  const dailyTokens = new Map<string, number>()
  const modelUsage: LocalUsage["modelUsage"] = {}
  const providers = new Set<ModelProvider>()
  const todayTokensByModel: Record<string, number> = {}
  for (const path of files) {
    let activity: SessionActivity[]
    try {
      ;({ activity } = await readSessionDigest(path))
    } catch {
      continue
    }
    if (!activity.some((event) => event.type === "prompt_admitted")) continue
    sessionCount += 1
    let activeToday = false
    // Older sessions only recorded admission. Keep those estimates readable, but prefer
    // actual starts so queued prompts do not contribute waiting time.
    const started = new Map<string, { start: number; exact: boolean }>()
    const intervals: { start: number; end: number; exact: boolean }[] = []
    for (const event of activity) {
      const at = timestamp(event.at)
      if (at !== undefined) days.add(localDateKey(new Date(at)))
      if (event.type === "usage_recorded") {
        totalTokens += event.usage.totalTokens
        promptTokens += event.usage.promptTokens
        completionTokens += event.usage.completionTokens
        if (event.provider) providers.add(event.provider)
        if (event.model) {
          const bucket = modelUsage[event.model] ?? {
            name: event.modelName ?? event.model,
            promptTokens: 0,
            completionTokens: 0,
          }
          bucket.promptTokens += event.usage.promptTokens
          bucket.completionTokens += event.usage.completionTokens
          modelUsage[event.model] = bucket
        }
        if (at === undefined) continue
        const key = localDateKey(new Date(at))
        dailyTokens.set(key, (dailyTokens.get(key) ?? 0) + event.usage.totalTokens)
        if (key !== today) continue
        todayTokens += event.usage.totalTokens
        if (event.model)
          todayTokensByModel[event.model] =
            (todayTokensByModel[event.model] ?? 0) + event.usage.totalTokens
      } else if (event.type === "prompt_admitted" || event.type === "turn_started") {
        if (event.type === "prompt_admitted") {
          promptCount += 1
          if (at !== undefined && localDateKey(new Date(at)) === today) {
            todayPrompts += 1
            activeToday = true
          }
        }
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
    if (activeToday) todaySessions += 1
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
    promptCount,
    todayPrompts,
    todaySessions,
    todayTokens,
    activeDates: [...days].sort(),
    providers: [...providers].sort(),
    modelUsage,
    todayTokensByModel,
  }
}

/**
 * Omarchy's agents bar panel draws any record in its usage directory, whoever wrote it, but its
 * refresh only runs Omarchy's bundled collectors. Otis writes its own entry after every turn.
 * Returns the record's path, or undefined off Omarchy.
 */
export async function publishOmarchyUsage(
  provider: ModelProvider | undefined,
  options: LocalStatsOptions = {},
) {
  if (process.platform !== "linux") return undefined
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  const directory = join(state, "omarchy", "agents", "usage")
  if (!existsSync(join(state, "omarchy"))) return undefined
  const stats = await calculateLocalStats(options)
  // The panel's plan line; Otis has no plan, so it says where its models ran. Fireworks is the
  // hosted provider; everything else runs on the user's machine or local network. The current
  // selection stands in until any usage is attributed.
  const served = new Set<string>(
    (stats.providers.length ? stats.providers : [provider]).map((entry) =>
      entry === "fireworks" ? "Hosted" : entry ? "Local" : "",
    ),
  )
  // Rows show the picker name; ids that share one (a fast-serving variant, the same model on two
  // local servers) add up under it.
  const modelUsage: Record<string, { inputTokens: number; outputTokens: number }> = {}
  const todayTokensByModel: Record<string, number> = {}
  for (const [model, { name, promptTokens, completionTokens }] of Object.entries(
    stats.modelUsage,
  )) {
    const row = modelUsage[name] ?? { inputTokens: 0, outputTokens: 0 }
    row.inputTokens += promptTokens
    row.outputTokens += completionTokens
    modelUsage[name] = row
    const today = stats.todayTokensByModel[model]
    if (today) todayTokensByModel[name] = (todayTokensByModel[name] ?? 0) + today
  }
  const record = {
    id: "otis",
    name: "Otis",
    ready: stats.promptCount > 0,
    tierLabel: ["Local", "Hosted"].filter((entry) => served.has(entry)).join(" + "),
    scope: "device",
    hasLocalStats: true,
    hasPromptStats: true,
    limits: [],
    usageStatusText: "",
    authHelpText: "",
    todayPrompts: stats.todayPrompts,
    todaySessions: stats.todaySessions,
    todayTotalTokens: stats.todayTokens,
    todayTokensByModel,
    // The panel's day rows read their token total from messageCount.
    recentDays: stats.recentActivity
      .slice(-7)
      .map(({ date, tokens }) => ({ date, messageCount: tokens })),
    totalPrompts: stats.promptCount,
    totalSessions: stats.sessionCount,
    activeDays: stats.activeDays,
    activeDates: stats.activeDates,
    modelUsage,
  }
  await mkdir(directory, { recursive: true })
  const file = join(directory, "otis.json")
  // The panel watches the file; a rename lands the whole record at once.
  const temporary = join(directory, `.otis.${process.pid}.json`)
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  await rename(temporary, file)
  return file
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
