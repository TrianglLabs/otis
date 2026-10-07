import type { TranscriptEntry } from "../../app/transcript.js"
import type {
  DesktopApi,
  DesktopEvent,
  DesktopSnapshot,
  DesktopStatus,
  TranscriptPatchOp,
} from "../contracts.js"

export type ViewState = DesktopSnapshot

/**
 * The renderer's display copy of application state. Starts from a snapshot, then applies ordered,
 * revision-stamped events. Events at or below the snapshot revision are duplicates a reloaded
 * renderer already received and are dropped. The application remains authoritative; this store
 * holds no behavior of its own.
 */
export class DesktopViewStore {
  #state: ViewState | undefined
  #listeners = new Set<() => void>()
  #unsubscribe: (() => void) | undefined

  constructor(readonly api: DesktopApi) {}

  async start() {
    // Subscribe before asking for the snapshot so no event is lost in between; events arriving
    // before the snapshot are buffered and replayed after it, with the revision guard dropping
    // anything the snapshot already included.
    const buffered: DesktopEvent[] = []
    let snapshotArrived = false
    this.#unsubscribe = this.api.subscribe((event) => {
      if (snapshotArrived) this.#apply(event)
      else buffered.push(event)
    })
    this.#state = await this.api.getSnapshot()
    snapshotArrived = true
    for (const event of buffered) this.#apply(event)
    this.#emit()
  }

  dispose() {
    this.#unsubscribe?.()
    this.#listeners.clear()
  }

  getState = () => this.#state

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #apply(event: DesktopEvent) {
    const state = this.#state
    if (!state || event.revision <= state.revision) return
    const status = event.type === "status" ? event.status : undefined
    const before = focusedRuntime(state.runtimes)
    const after = focusedRuntime(status?.runtimes ?? state.runtimes)
    let { entries } = state
    const transcripts = { ...state.transcripts }
    // Focus moved: lists follow their sessions. A session that was not on screen starts empty
    // and is reset by this same event's ops.
    if (after !== before && after !== undefined) {
      if (before !== undefined) transcripts[before] = entries
      entries = transcripts[after] ?? []
      delete transcripts[after]
    }
    if (event.ops) entries = applyTranscriptOps(entries, event.ops)
    for (const pane of event.panes ?? [])
      transcripts[pane.runtime] = applyTranscriptOps(transcripts[pane.runtime] ?? [], pane.ops)
    if (status?.panes)
      for (const key of Object.keys(transcripts))
        if (!status.panes.includes(Number(key))) delete transcripts[Number(key)]
    // A status carries the fields that changed, as fresh objects; within them, parts that did not
    // change keep their identity so selectors and memoized views stay put.
    const shared =
      status &&
      Object.fromEntries(
        Object.entries(status).map(([key, value]) => [
          key,
          share(state[key as keyof ViewState], value),
        ]),
      )
    this.#state = { ...state, ...shared, revision: event.revision, entries, transcripts }
    this.#emit()
  }

  #emit() {
    for (const listener of this.#listeners) listener()
  }
}

function focusedRuntime(runtimes: DesktopStatus["runtimes"]) {
  return runtimes.find((runtime) => runtime.focused)?.runtime
}

function applyTranscriptOps(
  entries: TranscriptEntry[],
  ops: TranscriptPatchOp[],
): TranscriptEntry[] {
  // Map insertion order matches the transcript: replacing keeps a position, remove + upsert moves
  // it to the end. Index once per batch instead of scanning the entire history for every operation.
  const next = new Map(entries.map((entry) => [entry.id, entry]))
  for (const op of ops) {
    if (op.op === "reset") {
      next.clear()
      for (const entry of op.entries) next.set(entry.id, entry)
    } else if (op.op === "upsert") {
      if (!shallowEqual(next.get(op.entry.id), op.entry)) next.set(op.entry.id, op.entry)
    } else if (op.op === "append") {
      const entry = next.get(op.id)
      if (entry) next.set(op.id, { ...entry, text: entry.text.slice(0, op.at) + op.text })
    } else {
      next.delete(op.id)
    }
  }
  const result = [...next.values()]
  return result.length === entries.length &&
    result.every((entry, index) => entry === entries[index])
    ? entries
    : result
}

/**
 * `next` with every array and plain object that equals its counterpart in `previous` replaced
 * by that counterpart, down to the leaves, so a value that crossed IPC unchanged is the same
 * reference it was.
 */
export function share<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return next
  if (Array.isArray(previous) && Array.isArray(next)) {
    const items = next.map((item, index) => share(previous[index], item))
    return items.length === previous.length &&
      items.every((item, index) => item === previous[index])
      ? previous
      : (items as T)
  }
  if (!isPlain(previous) || !isPlain(next)) return next
  const result: Record<string, unknown> = {}
  let same = Object.keys(previous).length === Object.keys(next).length
  for (const [key, value] of Object.entries(next)) {
    result[key] = share(previous[key], value)
    if (!Object.hasOwn(previous, key) || result[key] !== previous[key]) same = false
  }
  return same ? previous : (result as T)
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function shallowEqual<T>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  const keys = Object.keys(left) as (keyof T)[]
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
  )
}
