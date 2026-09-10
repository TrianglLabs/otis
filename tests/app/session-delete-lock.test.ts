import { describe, expect, it, vi } from "vitest"
import { SessionCoordinator } from "../../src/app/sessions.js"
import { SubagentTraces } from "../../src/app/subagents.js"
import { TranscriptStore } from "../../src/app/transcript.js"
import { acquireSessionLock, createSession } from "../../src/storage/index.js"
import { useOtisHome } from "./support/otis-home.js"

// A controllable gate inside the real deletion: lets the test prove the write lock is still held mid-removal.
const gate = vi.hoisted(() => ({ active: false, entered: undefined as (() => void) | undefined, release: () => {} }))
vi.mock("../../src/storage/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/storage/index.js")>()
  return {
    ...original,
    deleteSession: async (options: Parameters<typeof original.deleteSession>[0]) => {
      if (gate.active) {
        gate.entered?.()
        await new Promise<void>((resolve) => {
          gate.release = resolve
        })
      }
      return original.deleteSession(options)
    },
  }
})

const isolate = useOtisHome()

async function coordinator(cwd: string) {
  return new SessionCoordinator({
    client: () => undefined,
    cwd,
    transcript: new TranscriptStore(),
    subagents: new SubagentTraces(),
    isBusy: () => false,
    isExiting: () => false,
  })
}

describe("session deletion locking", () => {
  it("keeps the write lock held until the file is gone, then releases it", async () => {
    const home = await isolate()
    const victim = await createSession({ cwd: home })
    await victim.admitPrompt("about to be deleted")
    const sessions = await coordinator(home)

    gate.active = true
    const deleteEntered = new Promise<void>((resolve) => {
      gate.entered = resolve
    })
    const deleting = sessions.delete(victim.id)
    await deleteEntered

    // While the file removal is in flight the guard must still own the lock.
    await expect(acquireSessionLock({ cwd: home, sessionId: victim.id })).rejects.toThrow(/already in use/)

    gate.release()
    gate.active = false
    await expect(deleting).resolves.toBe("deleted")

    // Afterward the id is free again (a fresh session with the same id could be locked).
    const lock = await acquireSessionLock({ cwd: home, sessionId: victim.id })
    await lock.release()
  })

  it("refuses to delete a session another instance holds, without touching the file", async () => {
    const home = await isolate()
    const victim = await createSession({ cwd: home })
    await victim.admitPrompt("held elsewhere")
    const holder = await coordinator(home)
    expect(await holder.select(victim.id)).toBe("loaded")

    const other = await coordinator(home)
    expect(await other.delete(victim.id)).toBe("locked")
    expect(await holder.select(victim.id)).toBe("noop") // still the holder's live session, intact
    await holder.releaseLock()
  })
})
