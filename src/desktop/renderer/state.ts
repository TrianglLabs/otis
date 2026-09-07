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

export function applyTranscriptOps(entries: readonly TranscriptEntry[], ops: TranscriptPatchOp[]): TranscriptEntry[] {
  const next = [...entries]
  for (const op of ops) {
    if (op.op === "reset") {
      next.length = 0
      next.push(...op.entries)
      continue
    }
    if (op.op === "upsert") {
      const index = next.findIndex((entry) => entry.id === op.entry.id)
      if (index === -1) next.push(op.entry)
      else next[index] = op.entry
      continue
    }
    const index = next.findIndex((entry) => entry.id === op.id)
    if (index !== -1) next.splice(index, 1)
  }
  return next
}
