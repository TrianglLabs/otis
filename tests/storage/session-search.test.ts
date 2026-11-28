import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { compactionSummaryMessage } from "../../src/core/compaction.js"
import type { ChatMessage } from "../../src/inference/types.js"
import { createSession, openSession, searchAllSessions } from "../../src/storage/session.js"
import { useOtisHome } from "../app/support/otis-home.js"

const isolate = useOtisHome()

afterEach(() => {
  vi.useRealTimers()
})

/** A workspace of its own under a fresh Otis home, so searches see only this test's sessions. */
async function workspace() {
  await isolate("otis-session-search-")
  return resolve("/work/search")
}

async function writeSession(cwd: string, userText: string, assistantText: string) {
  const session = await createSession({ cwd })
  const admission = await session.admitPrompt(userText)
  const turnMessages: ChatMessage[] = [
    { role: "user", content: userText },
    { role: "assistant", content: [{ type: "text", text: assistantText }] },
  ]
  await session.completeTurn(admission, turnMessages)
  return session
}

describe("session search", () => {
  it("finds content written before a compaction", async () => {
    const cwd = await workspace()
    const session = await createSession({ cwd })
    // "zephyr" lives only in pre-compaction content — not the title, not the compacted model
    // context.
    const admission = await session.admitPrompt("hello there")
    await session.completeTurn(admission, [
      { role: "user", content: "hello there" },
      {
        role: "assistant",
        content: [{ type: "text", text: "The zephyr protocol uses rotating keys." }],
      },
    ])
    await session.compact("Summary", [
      { role: "user", content: "a different follow up" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ])

    const results = await searchAllSessions("zephyr")
    expect(results).toHaveLength(1)
    expect(results[0].snippet?.toLowerCase()).toContain("zephyr")
  })

  it("matches titles without a snippet, and content with a snippet from the matching message", async () => {
    const cwd = await workspace()
    await writeSession(
      cwd,
      "refactor the view store",
      "Split the store into slices and keep selectors stable.",
    )
    await writeSession(cwd, "fix the flaky lock test", "The lock waits for the drain.")

    const titleHits = await searchAllSessions("view store")
    expect(titleHits).toHaveLength(1)
    expect(titleHits[0].title).toBe("refactor the view store")
    expect(titleHits[0].snippet).toBeUndefined()

    // Content-only match: the query appears in the assistant text, not the title.
    const contentHits = await searchAllSessions("selectors")
    expect(contentHits).toHaveLength(1)
    expect(contentHits[0].snippet).toContain("selectors")
  })

  it("ranks title matches above content matches and keeps recency order inside each group", async () => {
    const cwd = await workspace()
    // Oldest first: content-only hit, then two title hits written later.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    await writeSession(cwd, "unrelated chat", "The migration plan mentions the palette redesign.")
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"))
    await writeSession(cwd, "palette tokens", "done")
    vi.setSystemTime(new Date("2026-01-03T00:00:00Z"))
    await writeSession(cwd, "palette search", "done")

    const results = await searchAllSessions("palette")
    expect(results.map((result) => result.title)).toEqual([
      "palette search",
      "palette tokens",
      "unrelated chat",
    ])
    expect(results[2].snippet).toContain("palette redesign")
  })

  it("skips compaction summaries and returns everything for an empty query", async () => {
    const cwd = await workspace()
    const session = await openSession({ cwd })
    const admission = await session.admitPrompt("hello")
    await session.completeTurn(admission, [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ])
    const summary = compactionSummaryMessage("discussed the zephyr budget")
    const summaryAdmission = await session.admitPrompt(summary)
    await session.completeTurn(summaryAdmission, [
      summary,
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ])

    // The word only appears inside the compaction summary, which is not searchable.
    await expect(searchAllSessions("zephyr")).resolves.toEqual([])
    await expect(searchAllSessions("  ")).resolves.toHaveLength(1)
    await expect(searchAllSessions("nothing matches this")).resolves.toEqual([])
  })
})
