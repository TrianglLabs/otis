import { describe, expect, it } from "vitest"
import type { TranscriptEntry } from "../../../src/app/transcript.js"
import type { DesktopApi, DesktopEvent, DesktopSnapshot, DesktopStatus } from "../../../src/desktop/contracts.js"
import { applyTranscriptOps, DesktopViewStore } from "../../../src/desktop/renderer/state.js"

function entry(id: number, text: string): TranscriptEntry {
  return { id, kind: "message", speaker: "Otis", text }
}

describe("applyTranscriptOps", () => {
  it("appends new entries and patches existing ones in place", () => {
    const base = [entry(1, "a"), entry(2, "b")]
    const next = applyTranscriptOps(base, [
      { op: "upsert", entry: entry(2, "b updated") },
      { op: "upsert", entry: entry(3, "c") },
    ])
    expect(next.map((item) => item.text)).toEqual(["a", "b updated", "c"])
    expect(base.map((item) => item.text)).toEqual(["a", "b"])
  })

  it("reset replaces the list and later ops apply on top", () => {
    const base = [entry(1, "a"), entry(2, "b")]
    const next = applyTranscriptOps(base, [
      { op: "upsert", entry: entry(9, "stale") },
      { op: "reset", entries: [entry(1, "fresh")] },
      { op: "upsert", entry: entry(2, "after reset") },
    ])
    expect(next.map((item) => item.text)).toEqual(["fresh", "after reset"])
  })

  it("remove then upsert moves an entry to the end", () => {
    const base = [entry(1, "queued"), entry(2, "working")]
    const next = applyTranscriptOps(base, [
      { op: "remove", id: 1 },
      { op: "upsert", entry: entry(1, "activated") },
    ])
    expect(next.map((item) => item.text)).toEqual(["working", "activated"])
  })
})

describe("DesktopViewStore", () => {
  const status: DesktopStatus = {
    busy: false,
    phase: "idle",
    model: null,
    modelState: "unconfigured",
    modelError: undefined,
    session: null,
    sessions: [],
    contextTokens: undefined,
    contextLimit: 128_000,
    diffs: { added: 0, removed: 0 },
    permission: null,
    stats: undefined,
    modelLoad: null,
    subagents: [],
    agentsPanelVisible: true,
    theme: "default",
    thinkingVisible: true,
    fastServing: { available: false, enabled: false },
    hostedConfigured: false,
    pairConfigured: false,
    pairEndpoints: {},
    debug: false,
  }

  function snapshot(): DesktopSnapshot {
    return {
      platform: "darwin",
      version: "test",
      workspace: { label: "~/ws", path: "/ws" },
      ...status,
      entries: [entry(1, "from snapshot")],
      revision: 5,
    }
  }

  function fakeApi(): { api: DesktopApi; emit(event: DesktopEvent): void } {
    let listener: ((event: DesktopEvent) => void) | undefined
    return {
      emit: (event) => listener?.(event),
      api: {
        getSnapshot: async () => snapshot(),
        sendPrompt: async () => ({ accepted: true, delivery: "started" }),
        stop: async () => {},
        respondToPermission: async () => {},
        selectSession: async () => ({ ok: true }),
        startNewSession: async () => ({ ok: true }),
        getSubagentTrace: async () => [],
        setAgentsPanelVisible: async () => {},
        setTheme: async () => {},
        setThinkingVisible: async () => {},
        setFastServing: async () => ({ ok: true }),
        openFireworksKeyPage: async () => {},
        setFireworksApiKey: async () => ({ ok: true }),
        connectPairEndpoints: async () => ({ ok: true }),
        listDownloadedModels: async () => [],
        deleteLocalModel: async () => ({ ok: true }),
        setDebugMode: async () => {},
        deleteSession: async () => ({ ok: true }),
        listModels: async () => [],
        selectModel: async () => ({ ok: true }),
        cancelModelSelection: async () => {},
        subscribe: (next) => {
          listener = next
          return () => {
            listener = undefined
          }
        },
      },
    }
  }

  it("starts from the snapshot, replays buffered events, and drops stale revisions", async () => {
    const { api, emit } = fakeApi()
    const store = new DesktopViewStore(api)

    const startTask = store.start()
    // An event that races the snapshot must still be applied after it.
    emit({ type: "transcript", revision: 6, ops: [{ op: "upsert", entry: entry(2, "streamed") }] })
    await startTask

    expect(store.getState()?.entries.map((item) => item.text)).toEqual(["from snapshot", "streamed"])

    // A duplicate at an already-applied revision is dropped.
    emit({ type: "transcript", revision: 6, ops: [{ op: "upsert", entry: entry(3, "duplicate stale") }] })
    expect(store.getState()?.entries.map((item) => item.text)).toEqual(["from snapshot", "streamed"])

    emit({ type: "status", revision: 7, status: { ...status, busy: true } })
    expect(store.getState()?.busy).toBe(true)
    expect(store.getState()?.revision).toBe(7)
  })
})
