import { basename } from "node:path"
import { describeError } from "../inference/errors.js"
import {
  nextRunAt,
  parseSchedule,
  type Routine,
  type RoutineInput,
  type RoutineRun,
  routinesFile,
  routineText,
  saveRoutines,
} from "../local/routines.js"
import type { Application, SelectionResult, SessionRuntime } from "./application.js"
import type { ConversationTurnResult } from "./conversation.js"

/**
 * A routine as interfaces list it: its folder's name, the runtime of a run on now, and what
 * comes next.
 */
export type RoutineStatus = Routine & { folder: string; runtime?: number; nextRunAt?: string }

/** What running routines needs from the interface that hosts them. */
export type RoutineHost = {
  /** Takes a finished run's runtime back: closes it, or keeps it while it is on screen. */
  release: (runtime: SessionRuntime) => unknown
  /** Puts a run's runtime on the routine's model, by picker key, from the host's catalog. */
  selectModel: (runtime: SessionRuntime, key: string) => Promise<SelectionResult>
}

const RUN_TIMEOUT_MS = 30 * 60_000
const TICK_MS = 30_000

/**
 * The saved routines, their scheduler, and their runs. A run is an ordinary runtime in the
 * routine's folder with the routine's permission mode, so it shows up beside any other session
 * and is cancelled like one. The list can be edited anywhere (the `routines` tool, the desktop);
 * runs need a host that attached, which only the desktop runtime and `otis serve` do.
 */
export class Routines {
  readonly #routines: Routine[]
  #host: RoutineHost | undefined
  /** A run on now; `null` while its runtime is being set up. */
  readonly #running = new Map<string, SessionRuntime | null>()
  readonly #listeners = new Set<() => void>()
  readonly #file: string
  readonly #now: () => Date
  readonly #tickMs: number
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(
    readonly app: Application,
    routines: Routine[],
    options: { file?: string; now?: () => Date; tickMs?: number } = {},
  ) {
    this.#routines = routines
    this.#file = options.file ?? routinesFile()
    this.#now = options.now ?? (() => new Date())
    this.#tickMs = options.tickMs ?? TICK_MS
  }

  /** The host that runs routines: it places finished runs and knows the model catalog. */
  attach(host: RoutineHost) {
    this.#host = host
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  list(): RoutineStatus[] {
    return this.#routines.map((routine) => ({
      ...routine,
      folder: basename(routine.cwd),
      runtime: this.#running.get(routine.id)?.id,
      nextRunAt: nextRunAt(routine)?.toISOString(),
    }))
  }

  /** Checks for due routines now and every tick; a routine already running is not started twice. */
  start() {
    this.tick()
    this.#timer ??= setInterval(() => this.tick(), this.#tickMs)
    this.#timer.unref?.()
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
  }

  tick() {
    const now = this.#now()
    for (const routine of this.#routines) {
      const due = nextRunAt(routine)
      if (due && due <= now && !this.#running.has(routine.id)) void this.run(routine.id)
    }
  }

  /**
   * Adds or replaces a routine. An interval still counts from the last start. A replaced routine
   * keeps its object, so a run in flight records its outcome on the routine as saved.
   */
  async save(input: RoutineInput): Promise<Routine> {
    const existing = this.#routines.find((routine) => routine.id === input.id)
    if (input.id && !existing) throw new Error("That routine no longer exists.")
    const routine: Routine = {
      ...existing,
      id: existing?.id ?? `routine_${this.#now().getTime().toString(36)}`,
      name: routineText(input.name, "name").trim(),
      prompt: routineText(input.prompt, "prompt"),
      cwd: routineText(input.cwd, "cwd"),
      schedule: parseSchedule(input.schedule),
      model: input.model,
      auto: input.auto,
      enabled: input.enabled,
      createdAt: existing?.createdAt ?? this.#now().toISOString(),
    }
    if (existing) Object.assign(existing, routine)
    else this.#routines.push(routine)
    await this.#persist()
    return existing ?? routine
  }

  /** Removes a routine, stopping its run first; one already gone is nothing to do. */
  async remove(id: string) {
    this.cancel(id)
    const index = this.#routines.findIndex((routine) => routine.id === id)
    if (index < 0) return
    this.#routines.splice(index, 1)
    await this.#persist()
  }

  cancel(id: string) {
    this.#running.get(id)?.conversation.stop()
  }

  /** Opening a run's session, or watching it finish, is seeing it. */
  async seen(sessionId: string) {
    const run = this.#routines.find((entry) => entry.lastRun?.sessionId === sessionId)?.lastRun
    if (!run || run.seen) return
    run.seen = true
    await this.#persist()
  }

  /**
   * One run: a fresh session in the routine's folder, titled after it, with the prompt submitted
   * and the outcome recorded as its last run. Refused synchronously for an unknown or running
   * routine, or where no host runs routines; the returned promise settles with the run and never
   * rejects. A run the model cannot admit yet (starting, switching, none configured) is not
   * recorded: it stays due for the next tick.
   */
  run(id: string): Promise<RoutineRun | undefined> {
    const routine = this.#routines.find((entry) => entry.id === id)
    if (!routine) throw new Error("That routine no longer exists.")
    if (this.#running.has(id)) throw new Error("That routine is already running.")
    if (!this.#host) throw new Error("Routines run in the desktop app and under otis serve.")
    this.#running.set(id, null)
    return this.#run(routine, this.#host)
  }

  async #run(routine: Routine, host: RoutineHost): Promise<RoutineRun | undefined> {
    const startedAt = this.#now()
    const run: RoutineRun = { startedAt: startedAt.toISOString(), status: "running" }
    let runtime: SessionRuntime | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const opened = this.app.addRuntime(
        await this.app.workspace(routine.cwd),
        routine.auto ? "auto" : "dontAsk",
      )
      runtime = opened
      this.#running.set(routine.id, opened)
      // Removed while its folder loaded: nothing to run. Its own model comes before the gate, so
      // a routine with one is not held back by the session's model.
      if (!this.#routines.includes(routine)) throw new Error("That routine no longer exists.")
      if (routine.model) {
        const selected = await host.selectModel(opened, routine.model)
        if (!selected.ok) throw new Error(selected.reason)
      }
      if (this.app.admissionGate(opened)) {
        this.#running.delete(routine.id)
        await this.app.closeRuntime(opened)
        return undefined
      }
      const session = await opened.sessions.ensure()
      await session.renameTitle(`${routine.name} · ${startedAt.toLocaleString()}`)
      run.sessionId = session.id
      run.dirName = opened.sessions.currentDirName
      routine.lastRun = run
      await this.#persist()
      const settled = new Promise<ConversationTurnResult["status"]>((resolve) => {
        const stop = opened.conversation.subscribe((event) => {
          if (event.type !== "settled") return
          stop()
          resolve(event.result.status)
        })
      })
      timeout = setTimeout(() => opened.conversation.stop(), RUN_TIMEOUT_MS)
      await opened.conversation.submit(await this.app.buildPrompt(routine.prompt, []))
      const result = await settled
      run.status = result === "incomplete" ? "interrupted" : result
    } catch (error) {
      run.status = "error"
      run.error = describeError(error)
    } finally {
      clearTimeout(timeout)
    }
    run.finishedAt = this.#now().toISOString()
    routine.lastRun = run
    this.#running.delete(routine.id)
    try {
      await this.#persist()
      if (runtime) await host.release(runtime)
    } catch {
      // The run is recorded in memory and listed; a failed write or close is not its outcome.
    }
    return run
  }

  async #persist() {
    await saveRoutines(this.#routines, this.#file)
    for (const listener of this.#listeners) listener()
  }
}
