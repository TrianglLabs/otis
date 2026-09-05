import { readdir } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { SessionCoordinator } from "../../src/app/sessions.js"
import { SubagentTraces } from "../../src/app/subagents.js"
import { TranscriptStore } from "../../src/app/transcript.js"
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
})
