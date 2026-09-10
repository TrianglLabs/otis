import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { COMPACTION_SUMMARY_PREFIX } from "../../src/core/compaction.js"
import type { ChatMessage } from "../../src/inference/types.js"
import { createSession, openSession, searchSessions } from "../../src/storage/session.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function trackedTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "otis-session-search-"))
  tempDirs.push(dir)
  return dir
}

function sessionDir(cwd: string) {
  return join(cwd, "sessions")
}

async function writeSession(cwd: string, userText: string, assistantText: string) {
  const session = await createSession({ cwd, directory: sessionDir(cwd) })
  const admission = await session.admitPrompt(userText)
  const turnMessages: ChatMessage[] = [
    { role: "user", content: userText },
    { role: "assistant", content: [{ type: "text", text: assistantText }] },
  ]
  await session.completeTurn(admission, turnMessages)
  return session
}

describe("searchSessions", () => {
  it("finds content written before a compaction", async () => {
    const cwd = await trackedTempDir()
    const session = await createSession({ cwd, directory: sessionDir(cwd) })
    // "zephyr" lives only in pre-compaction content — not the title, not the compacted model context.
    const admission = await session.admitPrompt("hello there")
    await session.completeTurn(admission, [
      { role: "user", content: "hello there" },
      { role: "assistant", content: [{ type: "text", text: "The zephyr protocol uses rotating keys." }] },
    ])
    await session.compact("Summary", [
      { role: "user", content: "a different follow up" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ])

    const results = await searchSessions({ cwd, directory: sessionDir(cwd) }, "zephyr")
    expect(results).toHaveLength(1)
    expect(results[0].snippet?.toLowerCase()).toContain("zephyr")
  })

  it("matches titles without a snippet, and content with a snippet from the matching message", async () => {
    const cwd = await trackedTempDir()
    await writeSession(cwd, "refactor the view store", "Split the store into slices and keep selectors stable.")
    await writeSession(cwd, "fix the flaky lock test", "The lock waits for the drain.")

    const titleHits = await searchSessions({ cwd, directory: sessionDir(cwd) }, "view store")
    expect(titleHits).toHaveLength(1)
    expect(titleHits[0].title).toBe("refactor the view store")
    expect(titleHits[0].snippet).toBeUndefined()

    // Content-only match: the query appears in the assistant text, not the title.
    const contentHits = await searchSessions({ cwd, directory: sessionDir(cwd) }, "selectors")
    expect(contentHits).toHaveLength(1)
    expect(contentHits[0].snippet).toContain("selectors")
  })

  it("ranks title matches above content matches and keeps recency order inside each group", async () => {
    const cwd = await trackedTempDir()
    // Oldest first: content-only hit, then two title hits written later.
    await writeSession(cwd, "unrelated chat", "The migration plan mentions the palette redesign.")
    await writeSession(cwd, "palette tokens", "done")
    await writeSession(cwd, "palette search", "done")

    const results = await searchSessions({ cwd, directory: sessionDir(cwd) }, "palette")
    expect(results.map((result) => result.title)).toEqual(["palette search", "palette tokens", "unrelated chat"])
    expect(results[2].snippet).toContain("palette redesign")
  })

  it("skips compaction summaries and returns everything for an empty query", async () => {
    const cwd = await trackedTempDir()
    const session = await openSession({ cwd, directory: sessionDir(cwd) })
    const admission = await session.admitPrompt("hello")
    await session.completeTurn(admission, [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ])
    const summaryAdmission = await session.admitPrompt(`${COMPACTION_SUMMARY_PREFIX}\n\ndiscussed the zephyr budget`)
    await session.completeTurn(summaryAdmission, [
      { role: "user", content: `${COMPACTION_SUMMARY_PREFIX}\n\ndiscussed the zephyr budget` },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ])

    // The word only appears inside the compaction summary, which is not searchable.
    await expect(searchSessions({ cwd, directory: sessionDir(cwd) }, "zephyr")).resolves.toEqual([])
    await expect(searchSessions({ cwd, directory: sessionDir(cwd) }, "  ")).resolves.toHaveLength(1)
    await expect(searchSessions({ cwd, directory: sessionDir(cwd) }, "nothing matches this")).resolves.toEqual([])
  })
})
