import { describe, expect, it } from "vitest"
import type { TranscriptEntry } from "../../../src/app/transcript.js"
import type {
  DesktopApi,
  DesktopEvent,
  DesktopSnapshot,
  DesktopStatus,
  TranscriptPatchOp,
} from "../../../src/desktop/contracts.js"
import { DesktopViewStore, reconcileTraceEntries } from "../../../src/desktop/renderer/state.js"
import {
  fakeApi as fakeDesktopApi,
  snapshotFixture,
  statusFixture,
} from "../support/desktop-api.js"

function entry(id: number, text: string): TranscriptEntry {
  return { id, kind: "message", speaker: "Otis", text }
}

const status: DesktopStatus = statusFixture({
  workspace: { label: "~/ws", path: "/ws" },
  contextLimit: 128_000,
  thinkingVisible: true,
})

function snapshot(entries: TranscriptEntry[]): DesktopSnapshot {
  return snapshotFixture({ ...status, version: "test", entries, revision: 5 })
}

function fakeApi(entries: TranscriptEntry[]): { api: DesktopApi; emit(event: DesktopEvent): void } {
  let listener: ((event: DesktopEvent) => void) | undefined
  return {
    emit: (event) => listener?.(event),
    api: fakeDesktopApi(snapshot(entries), {
      subscribe: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
    }),
  }
}

/** The transcript after one patch event lands on a store seeded with `base`. */
async function patched(base: TranscriptEntry[], ops: TranscriptPatchOp[]) {
  const { api, emit } = fakeApi(base)
  const store = new DesktopViewStore(api)
  await store.start()
  emit({ type: "transcript", revision: 6, ops })
  const entries = store.getState()?.entries
  if (!entries) throw new Error("store has no state")
  return entries
}

describe("transcript patches", () => {
  it("preserves unchanged rows and ignores identical deliveries without replacing the array", async () => {
    const base = [entry(1, "a"), entry(2, "b")]
    expect(
      await patched(base, [
        { op: "upsert", entry: { ...base[0] } },
        { op: "remove", id: 99 },
      ]),
    ).toBe(base)
    const next = await patched(base, [{ op: "upsert", entry: entry(2, "changed") }])
    expect(next[0]).toBe(base[0])
    expect(next[1]).not.toBe(base[1])
  })

  it("retains unchanged trace rows across IPC snapshots while honoring edits, deletions, and ordering", () => {
    const base = [entry(1, "a"), entry(2, "b"), entry(3, "c")]
    expect(reconcileTraceEntries(base, structuredClone(base))).toBe(base)
    const next = reconcileTraceEntries(base, [entry(3, "c"), entry(2, "updated")])
    expect(next[0]).toBe(base[2])
    expect(next.map((row) => row.text)).toEqual(["c", "updated"])
  })
  it("appends new entries and patches existing ones in place", async () => {
    const base = [entry(1, "a"), entry(2, "b")]
    const next = await patched(base, [
      { op: "upsert", entry: entry(2, "b updated") },
      { op: "upsert", entry: entry(3, "c") },
    ])
    expect(next.map((item) => item.text)).toEqual(["a", "b updated", "c"])
    expect(base.map((item) => item.text)).toEqual(["a", "b"])
  })

  it("reset replaces the list and later ops apply on top", async () => {
    const base = [entry(1, "a"), entry(2, "b")]
    const next = await patched(base, [
      { op: "upsert", entry: entry(9, "stale") },
      { op: "reset", entries: [entry(1, "fresh")] },
      { op: "upsert", entry: entry(2, "after reset") },
    ])
    expect(next.map((item) => item.text)).toEqual(["fresh", "after reset"])
  })

  it("remove then upsert moves an entry to the end", async () => {
    const base = [entry(1, "queued"), entry(2, "working")]
    const next = await patched(base, [
      { op: "remove", id: 1 },
      { op: "upsert", entry: entry(1, "activated") },
    ])
    expect(next.map((item) => item.text)).toEqual(["working", "activated"])
  })
})

describe("DesktopViewStore", () => {
  it("starts from the snapshot, replays buffered events, and drops stale revisions", async () => {
    const { api, emit } = fakeApi([entry(1, "from snapshot")])
    const store = new DesktopViewStore(api)

    const startTask = store.start()
    // An event that races the snapshot must still be applied after it.
    emit({ type: "transcript", revision: 6, ops: [{ op: "upsert", entry: entry(2, "streamed") }] })
    await startTask

    expect(store.getState()?.entries.map((item) => item.text)).toEqual([
      "from snapshot",
      "streamed",
    ])

    // A duplicate at an already-applied revision is dropped.
    emit({
      type: "transcript",
      revision: 6,
      ops: [{ op: "upsert", entry: entry(3, "duplicate stale") }],
    })
    expect(store.getState()?.entries.map((item) => item.text)).toEqual([
      "from snapshot",
      "streamed",
    ])

    emit({ type: "status", revision: 7, status: { ...status, busy: true } })
    expect(store.getState()?.busy).toBe(true)
    expect(store.getState()?.revision).toBe(7)
  })

  it("keeps each pane's transcript apart and follows focus without reloading", async () => {
    const runtime = (id: number, focused: boolean) => ({
      runtime: id,
      session: null,
      focused,
      busy: false,
      unseen: false,
      diffs: { added: 0, removed: 0 },
      contextTokens: 0,
    })
    const { api, emit } = fakeApi([entry(1, "focused")])
    const store = new DesktopViewStore(api)
    await store.start()
    emit({
      type: "status",
      revision: 6,
      status: { ...status, runtimes: [runtime(1, true), runtime(2, false)], panes: [1, 2] },
      panes: [{ runtime: 2, ops: [{ op: "reset", entries: [entry(1, "beside")] }] }],
    })
    emit({ type: "transcript", revision: 7, ops: [{ op: "upsert", entry: entry(2, "more") }] })
    emit({
      type: "transcript",
      revision: 8,
      panes: [{ runtime: 2, ops: [{ op: "upsert", entry: entry(2, "beside too") }] }],
    })
    const before = store.getState()
    expect(before).toMatchObject({
      entries: [entry(1, "focused"), entry(2, "more")],
      transcripts: { 2: [entry(1, "beside"), entry(2, "beside too")] },
    })

    // Focus moves to the other pane: the lists change places, the same arrays.
    emit({
      type: "status",
      revision: 9,
      status: { ...status, runtimes: [runtime(1, false), runtime(2, true)], panes: [1, 2] },
    })
    const after = store.getState()
    expect(after?.entries).toBe(before?.transcripts[2])
    expect(after?.transcripts[1]).toBe(before?.entries)
    expect(after?.transcripts[2]).toBeUndefined()

    // A pane taken off screen drops its list; focus moving to a session that was off screen
    // starts from the reset the same event carries.
    emit({
      type: "status",
      revision: 10,
      status: { ...status, runtimes: [runtime(1, false), runtime(3, true)], panes: [3] },
      ops: [{ op: "reset", entries: [entry(9, "fresh")] }],
    })
    expect(store.getState()).toMatchObject({ entries: [entry(9, "fresh")], transcripts: {} })
    store.dispose()
  })

  it("publishes a session reset and its metadata as one state change", async () => {
    const { api, emit } = fakeApi([entry(1, "from snapshot")])
    const store = new DesktopViewStore(api)
    await store.start()
    emit({
      type: "status",
      revision: 6,
      status: { ...status, session: { id: "old", title: "Old session" } },
    })
    const observed: (DesktopSnapshot | undefined)[] = []
    store.subscribe(() => observed.push(store.getState()))

    emit({ type: "status", revision: 7, status, ops: [{ op: "reset", entries: [] }] })

    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ session: null, entries: [], subagents: [], revision: 7 })
    store.dispose()
  })
})
