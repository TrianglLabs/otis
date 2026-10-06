import { existsSync } from "node:fs"
import { mkdir, readdir, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  addUsage,
  emptyUsage,
  isHostedProvider,
  type ModelProvider,
  type UsageTotals,
} from "../inference/types.js"
import { sessionRootDirectory } from "../storage/session-files.js"
import {
  readSessionDigest,
  type SessionActivity,
  type SessionDigest,
} from "../storage/session-index.js"

const ACHIEVEMENT_IDS = [
  "first-session",
  "local-model",
  "hosted-model",
  "coworker",
  "document",
  "skill",
  "deep-work",
  "week-streak",
  "night-owl",
  "early-bird",
  "ten-workspaces",
  "thirty-days",
] as const

export type AchievementId = (typeof ACHIEVEMENT_IDS)[number]

export function isAchievementId(value: unknown): value is AchievementId {
  return (ACHIEVEMENT_IDS as readonly unknown[]).includes(value)
}

/** When it was first earned, and how many times for the ones that repeat. */
export type Achievement = { at: string; count: number }

const HOUR_MS = 3_600_000

/** Every recorded request summed, with the home-screen figures derived from the same pass. */
export type LocalStats = UsageTotals & {
  streak: number
  sessionCount: number
  avgTokensPerSession: number
  avgSessionSeconds: number
  activeDays: number
  todayTokens: number
  recentActivity: LocalUsageDay[]
  /** By picker name; usage recorded before models were noted is left out. */
  modelUsage: Record<string, UsageTotals & { hosted: boolean }>
  /** Earned achievements only; the rest are locked. */
  achievements: Partial<Record<AchievementId, Achievement>>
}

/** What Omarchy's agents panel shows beyond the home screen, from the same pass. */
type LocalUsage = {
  promptCount: number
  todayPrompts: number
  todaySessions: number
  activeDates: string[]
  /** Every provider that served recorded usage. */
  providers: ModelProvider[]
  todayTokensByModel: Record<string, number>
}

type LocalUsageDay = {
  date: string
  tokens: number
}

type LocalStatsOptions = {
  sessionsRoot?: string
  now?: Date
  /** When the first skill collection was installed, for the achievement. */
  skillInstalledAt?: string
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
  let totals = emptyUsage()
  let totalDurationSeconds = 0
  let sessionCount = 0
  let promptCount = 0
  let todayPrompts = 0
  let todaySessions = 0
  let todayTokens = 0
  const today = localDateKey(now)
  const days = new Set<string>()
  const dailyTokens = new Map<string, number>()
  const modelUsage: LocalStats["modelUsage"] = {}
  const providers = new Set<ModelProvider>()
  const todayTokensByModel: Record<string, number> = {}
  const earnedAt = new Map<AchievementId, number>()
  const tallies = new Map<AchievementId, number>()
  const reach = (id: AchievementId, at: number | undefined) => {
    if (at !== undefined && at < (earnedAt.get(id) ?? Infinity)) earnedAt.set(id, at)
  }
  const earn = (id: AchievementId, at: number) => {
    tallies.set(id, (tallies.get(id) ?? 0) + 1)
    reach(id, at)
  }
  const workspaceFirstPrompt = new Map<string, number>()
  reach("skill", timestamp(options.skillInstalledAt))
  for (const path of files) {
    let activity: SessionActivity[]
    let artifacts: SessionDigest["artifacts"]
    try {
      ;({ activity, artifacts } = await readSessionDigest(path))
    } catch {
      continue
    }
    if (!activity.some((event) => event.type === "prompt_admitted")) continue
    sessionCount += 1
    let activeToday = false
    let nightOwlAt: number | undefined
    let earlyBirdAt: number | undefined
    for (const { endedAt } of artifacts) reach("document", timestamp(endedAt))
    // Older sessions only recorded admission. Keep those estimates readable, but prefer
    // actual starts so queued prompts do not contribute waiting time.
    const started = new Map<string, { start: number; exact: boolean }>()
    const intervals: { start: number; end: number; exact: boolean }[] = []
    for (const event of activity) {
      const at = timestamp(event.at)
      if (at !== undefined) days.add(localDateKey(new Date(at)))
      if (event.type === "usage_recorded") {
        const { usage } = event
        totals = addUsage(totals, usage)
        if (event.provider) {
          providers.add(event.provider)
          reach(isHostedProvider(event.provider) ? "hosted-model" : "local-model", at)
        }
        const name = event.modelName ?? event.model
        if (name) {
          modelUsage[name] = {
            hosted: isHostedProvider(event.provider),
            ...addUsage(modelUsage[name] ?? emptyUsage(), usage),
          }
        }
        if (at === undefined) continue
        const key = localDateKey(new Date(at))
        dailyTokens.set(key, (dailyTokens.get(key) ?? 0) + event.usage.totalTokens)
        if (key !== today) continue
        todayTokens += event.usage.totalTokens
        if (name)
          todayTokensByModel[name] = (todayTokensByModel[name] ?? 0) + event.usage.totalTokens
      } else if (event.type === "prompt_admitted" || event.type === "turn_started") {
        if (event.type === "prompt_admitted") {
          promptCount += 1
          if (at !== undefined) {
            const workspace = dirname(path)
            if (at < (workspaceFirstPrompt.get(workspace) ?? Infinity))
              workspaceFirstPrompt.set(workspace, at)
            const hour = new Date(at).getHours()
            if (hour < 4) nightOwlAt ??= at
            else if (hour < 6) earlyBirdAt ??= at
            if (localDateKey(new Date(at)) === today) {
              todayPrompts += 1
              activeToday = true
            }
          }
        }
        if (at !== undefined)
          started.set(event.promptId, { start: at, exact: event.type === "turn_started" })
      } else if (event.type === "turn_completed" || event.type === "turn_interrupted") {
        if (event.subagents > 0) reach("coworker", at)
        const turn = started.get(event.promptId)
        started.delete(event.promptId)
        if (turn !== undefined && at !== undefined && at >= turn.start)
          intervals.push({ ...turn, end: at })
      }
    }
    if (nightOwlAt) earn("night-owl", nightOwlAt)
    if (earlyBirdAt) earn("early-bird", earlyBirdAt)
    // Merge overlapping intervals in a session, including old queued admissions, so
    // the same wall-clock time is never counted twice. Idle gaps stay excluded.
    let through = -Infinity
    let milliseconds = 0
    for (const { start, end, exact } of intervals.sort((a, b) => a.start - b.start)) {
      const before = milliseconds
      milliseconds += Math.max(0, end - Math.max(start, through))
      if (before < HOUR_MS && milliseconds >= HOUR_MS) earn("deep-work", end)
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

  const firsts = [...workspaceFirstPrompt.values()].sort((a, b) => a - b)
  reach("first-session", firsts[0])
  reach("ten-workspaces", firsts[9])
  // Active days in order: the thirtieth earns "thirty days", and every seventh day of an unbroken
  // run earns "a week straight" again.
  const activeDates = [...days].sort()
  const activeDays = activeDates.map((key) => localDate(key).getTime())
  reach("thirty-days", activeDays[29])
  let run = 0
  for (const [index, day] of activeDays.entries()) {
    run = index > 0 && day - activeDays[index - 1] <= 25 * HOUR_MS ? run + 1 : 1
    if (run % 7 === 0) earn("week-streak", day)
  }
  const achievements: LocalStats["achievements"] = {}
  for (const [id, at] of earnedAt)
    achievements[id] = { at: new Date(at).toISOString(), count: tallies.get(id) ?? 1 }

  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 27)
  const recentActivity = Array.from({ length: 28 }, () => {
    const date = localDateKey(day)
    day.setDate(day.getDate() + 1)
    return { date, tokens: dailyTokens.get(date) ?? 0 }
  })
  return {
    ...totals,
    streak,
    sessionCount,
    avgTokensPerSession: sessionCount === 0 ? 0 : totals.totalTokens / sessionCount,
    avgSessionSeconds: sessionCount === 0 ? 0 : totalDurationSeconds / sessionCount,
    activeDays: days.size,
    todayTokens,
    recentActivity,
    modelUsage,
    achievements,
    promptCount,
    todayPrompts,
    todaySessions,
    activeDates,
    providers: [...providers].sort(),
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
  // The panel's plan line; Otis has no plan, so it says where its models ran: a hosted provider,
  // or the user's machine or local network. The current selection stands in until any usage is
  // attributed.
  const served = new Set<string>(
    (stats.providers.length ? stats.providers : [provider]).map((entry) =>
      isHostedProvider(entry) ? "Hosted" : entry ? "Local" : "",
    ),
  )
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
    todayTokensByModel: stats.todayTokensByModel,
    // The panel's day rows read their token total from messageCount.
    recentDays: stats.recentActivity
      .slice(-7)
      .map(({ date, tokens }) => ({ date, messageCount: tokens })),
    totalPrompts: stats.promptCount,
    totalSessions: stats.sessionCount,
    activeDays: stats.activeDays,
    activeDates: stats.activeDates,
    modelUsage: Object.fromEntries(
      Object.entries(stats.modelUsage).map(([name, { promptTokens, completionTokens }]) => [
        name,
        { inputTokens: promptTokens, outputTokens: completionTokens },
      ]),
    ),
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

function localDate(key: string) {
  const [year, month, day] = key.split("-").map(Number)
  return new Date(year, month - 1, day)
}

function localDateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
}

function timestamp(value: string | undefined) {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
