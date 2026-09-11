import type { TranscriptEntry } from "../../app/transcript.js"
import type { DesktopApi, DesktopEvent, DesktopSnapshot, TranscriptPatchOp } from "../contracts.js"

export type ViewState = DesktopSnapshot

/**
 * The renderer's display copy of application state. Starts from a snapshot, then applies ordered, revision-stamped
 * events. Events at or below the snapshot revision are duplicates a reloaded renderer already received and are
 * dropped. The application remains authoritative; this store holds no behavior of its own.
 */
export class DesktopViewStore {
  #state: ViewState | undefined
  #listeners = new Set<() => void>()
  #unsubscribe: (() => void) | undefined

  constructor(readonly api: DesktopApi) {}

  async start() {
    // Subscribe before asking for the snapshot so no event is lost in between; events arriving before the snapshot
    // are buffered and replayed after it, with the revision guard dropping anything the snapshot already included.
    const buffered: DesktopEvent[] = []
    let snapshotArrived = false
    this.#unsubscribe = this.api.subscribe((event) => {
      if (snapshotArrived) this.#apply(event)
      else buffered.push(event)
    })
    const snapshot = await this.api.getSnapshot()
    this.#state = snapshot
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
    if (event.type === "transcript") {
      this.#state = { ...state, revision: event.revision, entries: applyTranscriptOps(state.entries, event.ops) }
    } else {
      this.#state = { ...state, revision: event.revision, ...event.status }
    }
    this.#emit()
  }

  #emit() {
    for (const listener of this.#listeners) listener()
  }
}

export function applyTranscriptOps(entries: TranscriptEntry[], ops: TranscriptPatchOp[]): TranscriptEntry[] {
  // Map insertion order matches the transcript: replacing keeps a position, remove + upsert moves it to the end.
  // Index once per batch instead of scanning the entire history for every operation.
  const next = new Map(entries.map((entry) => [entry.id, entry]))
  for (const op of ops) {
    if (op.op === "reset") {
      next.clear()
      for (const entry of op.entries) next.set(entry.id, entry)
      continue
    }
    if (op.op === "upsert") {
      if (!shallowEqual(next.get(op.entry.id), op.entry)) next.set(op.entry.id, op.entry)
      continue
    }
    next.delete(op.id)
  }
  const result = [...next.values()]
  return result.length === entries.length && result.every((entry, index) => entry === entries[index]) ? entries : result
}

/** Trace snapshots cross IPC as fresh objects. Preserve unchanged rows just as transcript patches do. */
export function reconcileTraceEntries(previous: TranscriptEntry[], fetched: TranscriptEntry[]): TranscriptEntry[] {
  const byId = new Map(previous.map((entry) => [entry.id, entry]))
  const next = fetched.map((entry) => {
    const existing = byId.get(entry.id)
    return existing && shallowEqual(existing, entry) ? existing : entry
  })
  return next.length === previous.length && next.every((entry, index) => entry === previous[index]) ? previous : next
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
