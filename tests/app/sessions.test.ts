import { readdir } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"
import { SessionCoordinator } from "../../src/app/sessions.js"
import { SubagentTraces } from "../../src/app/subagents.js"
import { TranscriptStore } from "../../src/app/transcript.js"
import { compactionSummaryMessage } from "../../src/core/compaction.js"
import { createSession, defaultSessionDirectory } from "../../src/storage/index.js"
import { useOtisHome } from "./support/otis-home.js"

const isolate = useOtisHome()

async function coordinator() {
  const home = await isolate("otis-sessions-")
  const transcript = new TranscriptStore()
  const subagents = new SubagentTraces()
  return {
    home,
    cwd: home,
    transcript,
    sessions: new SessionCoordinator({
      client: () => undefined,
      cwd: home,
      transcript,
      subagents,
      isBusy: () => false,
      isExiting: () => false,
    }),
  }
}

describe("SessionCoordinator", () => {
  it("creates a session once and reuses it under OTIS_HOME", async () => {
    const { home, sessions } = await coordinator()
    const first = await sessions.ensure()
    const second = await sessions.ensure()
    expect(second.id).toBe(first.id)
    expect(sessions.current?.id).toBe(first.id)
    expect(await readdir(defaultSessionDirectory(home))).toContain(`${first.id}.jsonl`)
  })

  it("loads a saved session into the live transcript and can start a new one", async () => {
    const { cwd, sessions, transcript } = await coordinator()
    const stored = await createSession({ cwd })
    const admission = await stored.admitPrompt("hello from disk")
    await stored.completeTurn(admission, [{ role: "assistant", content: [{ type: "text", text: "hi" }] }])

    expect(await sessions.select(stored.id)).toBe("loaded")
    expect(transcript.history.some((message) => message.role === "user")).toBe(true)
    expect(sessions.activeLabel()).not.toBe("Current session")

    expect(sessions.startNew()).toBe(true)
    expect(sessions.current).toBeUndefined()
    expect(transcript.history).toEqual([])
    expect(sessions.diffs).toEqual({ added: 0, removed: 0 })
  })

  it("leaves the current session alone when the same id is selected again", async () => {
    const { sessions } = await coordinator()
    const session = await sessions.ensure()
    expect(await sessions.select(session.id)).toBe("noop")
  })

  it("reopens pre-compaction scrollback while keeping only compacted context for inference", async () => {
    const { cwd, sessions, transcript } = await coordinator()
    const stored = await createSession({ cwd })
    const admission = await stored.admitPrompt("old question")
    await stored.completeTurn(admission, [{ role: "assistant", content: [{ type: "text", text: "old answer" }] }])
    await stored.compact("Saved progress.", [])
    await sessions.select(stored.id)
    expect(transcript.history).toEqual([compactionSummaryMessage("Saved progress.")])
    expect(transcript.entries.map((entry) => entry.text)).toEqual(["old question", "old answer"])
  })
})

describe("session write locking (TUI/GUI concurrency)", () => {
  async function secondCoordinator(cwd: string) {
    return new SessionCoordinator({
      client: () => undefined,
      cwd,
      transcript: new TranscriptStore(),
      subagents: new SubagentTraces(),
      isBusy: () => false,
      isExiting: () => false,
    })
  }

  it("refuses to open a session another Otis instance holds", async () => {
    const { cwd, sessions } = await coordinator()
    const session = await sessions.ensure()

    const other = await secondCoordinator(cwd)
    expect(await other.select(session.id)).toBe("locked")
    expect(other.current).toBeUndefined()

    // After the holder lets go (app shutdown, start-new, delete), the session opens again.
    await sessions.releaseLock()
    expect(await other.select(session.id)).toBe("loaded")
    await other.releaseLock()
  })

  it("frees the lock on startNew so the previous session can be opened elsewhere", async () => {
    const { cwd, sessions } = await coordinator()
    const first = await sessions.ensure()
    expect(cwd).toBeTruthy()
    expect(sessions.startNew()).toBe(true)

    const other = await secondCoordinator(cwd)
    await vi.waitFor(async () => expect(await other.select(first.id)).toBe("loaded"))
    await other.releaseLock()
  })

  it("releases the lock when the current session is deleted", async () => {
    const { sessions } = await coordinator()
    const session = await sessions.ensure()
    // Deleting while held would strand other instances; deletion frees first, then removes.
    await sessions.releaseLock()
    expect(await sessions.delete(session.id)).toBe("deleted")
    expect(sessions.current).toBeUndefined()
    // A fresh ensure must not trip over a stale lock file.
    const next = await sessions.ensure()
    expect(next.id).not.toBe(session.id)
    await sessions.releaseLock()
  })
})

describe("duplicate session ids across storage dirs", () => {
  async function sessionIn(dirName: string, sessionId: string, text: string) {
    const { appendFile, mkdir } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { sessionRootDirectory } = await import("../../src/storage/index.js")
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
          message: { role: "user", content: text },
        }),
      { mode: 0o600 },
    )
    return dir
  }

  it("selecting the same id from another storage dir loads it instead of no-op'ing", async () => {
    const { sessions, transcript } = await coordinator()
    const own = await sessions.ensure()
    await own.admitPrompt("workspace default")
    const otherDir = await sessionIn("legacy-aaaaaaaaaaaa", own.id, "legacy conversation")

    // Same id, different store: must switch, not mistake it for the current session.
    expect(await sessions.select(own.id, { directory: otherDir })).toBe("loaded")
    expect(transcript.entries.some((entry) => entry.text === "legacy conversation")).toBe(true)
    expect(sessions.currentDirName).toBe("legacy-aaaaaaaaaaaa")

    // And selecting the truly-current identity is the only noop.
    expect(await sessions.select(own.id, { directory: otherDir })).toBe("noop")
    await sessions.releaseLock()
  })

  it("deleting another dir's same-id session neither bypasses its lock nor resets the current session", async () => {
    const { home, sessions } = await coordinator()
    const own = await sessions.ensure()
    await own.admitPrompt("still mine")
    const otherDir = await sessionIn("other-bbbbbbbbbbbb", own.id, "held elsewhere")

    // Another instance holds the other dir's session: deletion must refuse…
    const holder = new SessionCoordinator({
      client: () => undefined,
      cwd: home,
      transcript: new TranscriptStore(),
      subagents: new SubagentTraces(),
      isBusy: () => false,
      isExiting: () => false,
    })
    expect(await holder.select(own.id, { directory: otherDir })).toBe("loaded")
    expect(await sessions.delete(own.id, { directory: otherDir })).toBe("locked")
    expect(sessions.current?.id).toBe(own.id) // current session untouched

    // …and after the holder releases, deleting the other dir's copy must not reset our current session.
    await holder.releaseLock()
    expect(await sessions.delete(own.id, { directory: otherDir })).toBe("deleted")
    expect(sessions.current?.id).toBe(own.id)
    expect(sessions.currentDirName).not.toBe("other-bbbbbbbbbbbb")
    await sessions.releaseLock()
  })
})

describe("previewed-session deletion", () => {
  it("deleting the current session after its lock was released checks real ownership", async () => {
    const { home, sessions } = await coordinator()
    const own = await sessions.ensure()
    await own.admitPrompt("preview state")
    // Simulate the read-only preview: the runtime released our write lock.
    await sessions.releaseLock()

    // Another instance took the session over: deletion must refuse instead of orphaning its history.
    const holder = new SessionCoordinator({
      client: () => undefined,
      cwd: home,
      transcript: new TranscriptStore(),
      subagents: new SubagentTraces(),
      isBusy: () => false,
      isExiting: () => false,
    })
    expect(await holder.select(own.id)).toBe("loaded")
    expect(await sessions.delete(own.id)).toBe("locked")
    expect(sessions.current?.id).toBe(own.id) // preview survives the refused delete

    // Once the holder lets go, deletion proceeds and resets the preview.
    await holder.releaseLock()
    expect(await sessions.delete(own.id)).toBe("deleted")
    expect(sessions.current).toBeUndefined()
  })
})

describe("relock reloads history", () => {
  it("picks up events another instance wrote during the preview, then continues the sequence", async () => {
    const { home, sessions, transcript } = await coordinator()
    const own = await sessions.ensure()
    await own.admitPrompt("before preview")
    await sessions.releaseLock() // read-only preview state

    const holder = new SessionCoordinator({
      client: () => undefined,
      cwd: home,
      transcript: new TranscriptStore(),
      subagents: new SubagentTraces(),
      isBusy: () => false,
      isExiting: () => false,
    })
    expect(await holder.select(own.id)).toBe("loaded")
    await holder.current?.admitPrompt("written while previewing")
    await holder.releaseLock() // the other instance finished and closed

    expect(await sessions.relock()).toBe("ok")
    // The reload surfaced the interleaved event in both session state and the transcript.
    expect(transcript.entries.some((entry) => entry.text === "written while previewing")).toBe(true)

    // And the next append continues the reloaded sequence — no duplicated seq numbers.
    await sessions.current?.admitPrompt("after relock")
    const { readFile } = await import("node:fs/promises")
    const { sessionFile } = await import("../../src/storage/index.js")
    const lines = (await readFile(sessionFile({ cwd: home }, own.id), "utf8")).trim().split("\n")
    const seqs = lines.map((line) => (JSON.parse(line) as { seq: number }).seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    await sessions.releaseLock()
  })
})
