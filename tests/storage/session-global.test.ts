import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createSession, listAllSessions, searchAllSessions, sessionRootDirectory } from "../../src/storage/index.js"
import { useOtisHome } from "../app/support/otis-home.js"

const isolate = useOtisHome()

/** A session file the way releases before workspace registration wrote it: no marker, no cwd on the start event. */
async function legacySession(dirName: string, sessionId: string, title: string) {
  const dir = join(sessionRootDirectory(), dirName)
  await mkdir(dir, { recursive: true })
  const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`
  await appendFile(
    join(dir, `${sessionId}.jsonl`),
    line({ seq: 1, sessionId, at: new Date().toISOString(), type: "session_started", version: 1 }) +
      line({
        seq: 2,
        sessionId,
        at: new Date().toISOString(),
        type: "prompt_admitted",
        promptId: "p1",
        message: { role: "user", content: title },
      }),
    { mode: 0o600 },
  )
  return dir
}

describe("global session history", () => {
  it("merges sessions from every workspace, recency-first, tagged with the workspace path", async () => {
    await isolate()
    const cwdA = "/work/alpha"
    const cwdB = "/work/beta"
    const a = await createSession({ cwd: cwdA })
    const b = await createSession({ cwd: cwdB })
    await a.admitPrompt({ role: "user", content: "alpha work" })
    await b.admitPrompt({ role: "user", content: "beta work" })

    const all = await listAllSessions()
    expect(all).toHaveLength(2)
    const alpha = all.find((s) => s.id === a.id)
    const beta = all.find((s) => s.id === b.id)
    expect(alpha?.workspacePath).toBe(cwdA)
    expect(beta?.workspacePath).toBe(cwdB)
    expect(alpha?.dirName).not.toBe(beta?.dirName)
  })

  it("includes pre-registration history with no workspace path", async () => {
    await isolate()
    await legacySession("oldproj-0123456789ab", "default", "legacy question")
    const all = await listAllSessions()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe("default")
    expect(all[0].workspacePath).toBeUndefined()
    expect(all[0].dirName).toBe("oldproj-0123456789ab")
  })

  it("keeps duplicate session ids from different workspaces distinct", async () => {
    await isolate()
    await legacySession("one-aaaaaaaaaaaa", "default", "first default")
    await legacySession("two-bbbbbbbbbbbb", "default", "second default")
    const all = await listAllSessions()
    expect(all).toHaveLength(2)
    expect(new Set(all.map((s) => s.dirName)).size).toBe(2)
  })

  it("searches titles and content across workspaces with snippets", async () => {
    await isolate()
    const cwd = "/work/gamma"
    const byTitle = await createSession({ cwd })
    await byTitle.admitPrompt({ role: "user", content: "zephyr migration plan" })
    const other = await createSession({ cwd: "/work/delta" })
    await other.admitPrompt({ role: "user", content: "unrelated" })
    await legacySession("legacy-cccccccccccc", "default", "nothing here")

    const hits = await searchAllSessions("zephyr")
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe(byTitle.id)
    expect(hits[0].workspacePath).toBe(cwd)
  })

  it("stamps new sessions with their workspace path on the start event", async () => {
    await isolate()
    const cwd = "/work/stamped"
    const session = await createSession({ cwd })
    const started = session.events.find((event) => event.type === "session_started")
    expect(started && "cwd" in started && started.cwd).toBe(cwd)
  })

  it("still parses session files whose start event predates the cwd field", async () => {
    await isolate()
    const dir = await legacySession("ancient-dddddddddddd", "default", "old start")
    const { openSession } = await import("../../src/storage/index.js")
    const session = await openSession({ cwd: "", directory: dir, sessionId: "default" })
    expect(session.events[0].type).toBe("session_started")
  })

  it("ranks title matches above newer content matches from other workspaces", async () => {
    await isolate()
    const titled = await createSession({ cwd: "/work/titled" })
    await titled.admitPrompt({ role: "user", content: "zephyr plan" })
    const contentOnly = await createSession({ cwd: "/work/content" })
    const admission = await contentOnly.admitPrompt({ role: "user", content: "plain question" })
    await contentOnly.completeTurn(admission, [
      { role: "assistant", content: [{ type: "text", text: "mentions zephyr in passing" }] },
    ])

    const hits = await searchAllSessions("zephyr")
    expect(hits).toHaveLength(2)
    expect(hits[0].id).toBe(titled.id)
    expect(hits[0].snippet).toBeUndefined()
    expect(hits[1].id).toBe(contentOnly.id)
  })
})
