import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isRecord } from "../inference/errors.js"
import { localConfigDirectory } from "./paths.js"
import { writePrivateJson } from "./settings.js"

/** Every so many minutes, or once a day at a local `HH:MM`. */
export type RoutineSchedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string }

/** One run; a run that failed before it had a session has none to open. */
export type RoutineRun = {
  startedAt: string
  finishedAt?: string
  status: "running" | "complete" | "interrupted" | "error"
  /** Why an error run failed, when the failure was Otis' rather than the turn's. */
  error?: string
  /** The user has looked at the finished run: watched it end, or opened its session. */
  seen?: boolean
  sessionId?: string
  dirName?: string
}

/** A saved prompt Otis runs unattended in a folder, on a schedule, under its own permissions. */
export type Routine = {
  id: string
  name: string
  prompt: string
  cwd: string
  schedule: RoutineSchedule
  /** The model picker key its runs select; undefined runs on the session's current model. */
  model?: string
  /** Tools run without asking; otherwise anything that would ask is denied (read-only work). */
  auto: boolean
  enabled: boolean
  createdAt: string
  lastRun?: RoutineRun
}

/** What a form submits: the routine without its bookkeeping; without an id it is new. */
export type RoutineInput = Omit<Routine, "id" | "createdAt" | "lastRun"> & { id?: string }

export const ROUTINES_UNAVAILABLE = "Routines could not be loaded; check routines.json."

export const routinesFile = () => join(localConfigDirectory(), "routines.json")

export const routineText = (value: unknown, field: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid routine: ${field}.`)
  return value
}

export function parseSchedule(value: unknown): RoutineSchedule {
  if (!isRecord(value)) throw new Error("Invalid routine: schedule.")
  if (value.kind === "interval") {
    if (!Number.isInteger(value.minutes) || (value.minutes as number) < 1)
      throw new Error("Invalid routine: an interval is a whole number of minutes, at least 1.")
    return { kind: "interval", minutes: value.minutes as number }
  }
  if (
    value.kind === "daily" &&
    typeof value.time === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)
  )
    return { kind: "daily", time: value.time }
  throw new Error("Invalid routine: a daily time is HH:MM.")
}

const optional = (field: unknown) => (typeof field === "string" ? field : undefined)

function parseRoutine(value: unknown): Routine {
  if (!isRecord(value)) throw new Error("Invalid routine: expected an object.")
  const lastRun = value.lastRun
  if (lastRun !== undefined && !isRecord(lastRun)) throw new Error("Invalid routine: lastRun.")
  return {
    id: routineText(value.id, "id"),
    name: routineText(value.name, "name"),
    prompt: routineText(value.prompt, "prompt"),
    cwd: routineText(value.cwd, "cwd"),
    schedule: parseSchedule(value.schedule),
    model: optional(value.model),
    auto: value.auto === true,
    enabled: value.enabled !== false,
    createdAt: routineText(value.createdAt, "createdAt"),
    ...(lastRun
      ? {
          lastRun: {
            startedAt: routineText(lastRun.startedAt, "lastRun.startedAt"),
            finishedAt: optional(lastRun.finishedAt),
            // A run the process never finished recording ended with it.
            status:
              lastRun.status === "complete" || lastRun.status === "error"
                ? lastRun.status
                : "interrupted",
            error: optional(lastRun.error),
            ...(lastRun.seen === true ? { seen: true } : {}),
            sessionId: optional(lastRun.sessionId),
            dirName: optional(lastRun.dirName),
          },
        }
      : {}),
  }
}

/** The saved routines; a file that does not parse is an error, not an empty list. */
export async function loadRoutines(file = routinesFile()): Promise<Routine[]> {
  const content = await readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (content === undefined) return []
  const value: unknown = JSON.parse(content)
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.routines))
    throw new Error("Invalid routines file: expected version 1 with a routines list.")
  return value.routines.map(parseRoutine)
}

export function saveRoutines(routines: readonly Routine[], file = routinesFile()) {
  return writePrivateJson(file, { version: 1, routines })
}

/**
 * When a routine is next due. An interval counts from its last start, else from its creation; a
 * daily time that passed since the last start (or creation) is due now, so a slot missed while
 * Otis was closed runs once at launch rather than waiting a day.
 */
export function nextRunAt(routine: Routine): Date | undefined {
  if (!routine.enabled) return undefined
  const since = new Date(routine.lastRun?.startedAt ?? routine.createdAt)
  if (routine.schedule.kind === "interval")
    return new Date(since.getTime() + routine.schedule.minutes * 60_000)
  const [hours, minutes] = routine.schedule.time.split(":").map(Number)
  const slot = new Date(since)
  slot.setHours(hours, minutes, 0, 0)
  if (slot <= since) slot.setDate(slot.getDate() + 1)
  return slot
}

/** A schedule in words, for tool output and logs. */
export function describeSchedule(schedule: RoutineSchedule) {
  return schedule.kind === "interval"
    ? `every ${schedule.minutes} min`
    : `daily at ${schedule.time}`
}
