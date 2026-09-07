import { describe, expect, it } from "vitest"
import { type TranscriptChange, TranscriptStore } from "../../src/app/transcript.js"

function watch(store: TranscriptStore) {
  const changes: TranscriptChange[] = []
  const unsubscribe = store.subscribe((change) => changes.push(change))
  return { changes, unsubscribe }
}

describe("TranscriptStore change notifications", () => {
  it("replaces model context without publishing the compaction summary or resetting scrollback", () => {
    const store = new TranscriptStore()
    store.loadMessages([{ role: "user", content: "original task" }])
    const entries = [...store.entries]
    const { changes } = watch(store)

    store.loadCompacted("Internal summary", [])

    expect(changes).toEqual([])
    expect(store.entries).toEqual(entries)
    expect(store.history[0].content).toContain("Internal summary")
  })

  it("emits upsert for new and updated entries", () => {
    const store = new TranscriptStore()
    const { changes } = watch(store)

    const entry = store.addAssistantMessage("hello")
    store.updateEntry(entry.id, { text: "hello world", streaming: false })

    expect(changes).toEqual([
      { op: "upsert", id: entry.id },
      { op: "upsert", id: entry.id },
    ])
  })

  it("emits reset before replayed entries when messages are replaced", () => {
    const store = new TranscriptStore()
    store.addAssistantMessage("old")
    const { changes } = watch(store)

    store.replaceMessages([{ role: "user", content: "fresh" }])

    expect(changes[0]).toEqual({ op: "reset" })
    expect(changes.slice(1)).toEqual([{ op: "upsert", id: 1 }])
    expect(store.entries.map((entry) => entry.text)).toEqual(["fresh"])
  })

  it("emits remove then upsert when a queued message activates, moving it to the end", () => {
    const store = new TranscriptStore()
    const queued = store.addQueuedUserMessage("follow up")
    store.addAssistantMessage("working…")
    const { changes } = watch(store)

    expect(store.activatePendingUserMessage(queued.id)).toBe(true)

    expect(changes).toEqual([
      { op: "remove", id: queued.id },
      { op: "upsert", id: queued.id },
    ])
    expect(store.entries.at(-1)?.id).toBe(queued.id)
    expect(store.entries.at(-1)?.delivery).toBeUndefined()
  })

  it("emits remove and stops notifying after unsubscribe", () => {
    const store = new TranscriptStore()
    const entry = store.addAssistantMessage("gone")
    const { changes, unsubscribe } = watch(store)
    changes.length = 0

    expect(store.removeEntry(entry.id)).toBe(true)
    unsubscribe()
    store.addAssistantMessage("not observed")

    expect(changes).toEqual([{ op: "remove", id: entry.id }])
  })
})
