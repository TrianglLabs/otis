import { mkdir } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Application } from "../../../src/app/application.js"
import type { TurnResult, TurnRunnerOptions } from "../../../src/app/turn-runner.js"
import type { DesktopEvent } from "../../../src/desktop/contracts.js"
import { DesktopRuntime } from "../../../src/desktop/main/runtime.js"
import type { ChatMessage, InferenceClient } from "../../../src/inference/types.js"
import { loadLocalSettings } from "../../../src/local/settings.js"
import { createSession } from "../../../src/storage/index.js"
import { useOtisHome } from "../../app/support/otis-home.js"

const mocks = vi.hoisted(() => ({ executeTurn: vi.fn() }))
vi.mock("../../../src/app/turn-runner.js", () => ({ executeTurn: mocks.executeTurn }))
vi.mock("../../../src/inference/gguf-cache.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/inference/gguf-cache.js")>()
  return { ...original, isLocalGgufDownloaded: async () => false, listDownloadedLocalModels: async () => [] }
})

const isolate = useOtisHome()
const fakeClient: InferenceClient = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }

function turnEvents(text: string) {
  return async (options: TurnRunnerOptions): Promise<TurnResult> => {
    await options.onEvent?.({ type: "delta", text })
    const messages: ChatMessage[] = [{ role: "assistant", content: [{ type: "text", text }] }]
    await options.onEvent?.({ type: "complete", messages })
    return { status: "complete", messages, details: {} }
  }
}

async function setup() {
  const home = await isolate("otis-switch-")
  const cwd = join(home, "alpha")
  const otherCwd = join(home, "beta")
  await mkdir(cwd, { recursive: true })
  await mkdir(otherCwd, { recursive: true })
  const app = await Application.create({ cwd })
  app.models.client = fakeClient
  app.models.selectedId = "accounts/fireworks/models/fake"
  app.models.selectedProvider = "fireworks"
  const sent: DesktopEvent[] = []
  const runtime = DesktopRuntime.forApplication(app, {
    cwd,
    version: "test",
    platform: "darwin",
    send: (event) => sent.push(event),
  })
  return { app, runtime, sent, cwd, otherCwd }
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 60))
}

beforeEach(() => {
  mocks.executeTurn.mockReset()
})

describe("DesktopRuntime workspace switching", () => {
  it("lists sessions from every workspace in the status", async () => {
    const { runtime, cwd, otherCwd } = await setup()
    const local = await runtime.app.sessions.ensure()
    await local.admitPrompt("alpha session")
    const foreign = await createSession({ cwd: otherCwd })
    await foreign.admitPrompt("beta session")

    const snapshot = await runtime.snapshot()
    expect(snapshot.workspace.path).toBe(resolve(cwd))
    const paths = Object.fromEntries(snapshot.sessions.map((s) => [s.id, s.workspacePath]))
    expect(paths[local.id]).toBe(resolve(cwd))
    expect(paths[foreign.id]).toBe(resolve(otherCwd))
    const foreignRow = snapshot.sessions.find((s) => s.id === foreign.id)
    expect(foreignRow?.workspaceLabel).toBe("beta")
    await runtime.shutdown()
  })

  it("switches into another workspace's session: transcript resets, status follows, last workspace persists", async () => {
    const { runtime, sent, otherCwd } = await setup()
    mocks.executeTurn.mockImplementation(turnEvents("alpha reply"))
    await runtime.sendPrompt("hello alpha")
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).entries.some((e) => e.text === "alpha reply")).toBe(true),
    )
    const foreign = await createSession({ cwd: otherCwd })
    await foreign.admitPrompt("beta earlier work")

    const revisionBefore = (await runtime.snapshot()).revision
    const result = await runtime.switchWorkspace(otherCwd, foreign.id)
    expect(result.ok).toBe(true)
    await flush()

    const snapshot = await runtime.snapshot()
    expect(snapshot.workspace.path).toBe(resolve(otherCwd))
    expect(snapshot.workspace.label.endsWith("beta")).toBe(true)
    expect(snapshot.session?.id).toBe(foreign.id)
    expect(snapshot.entries.some((e) => e.text === "alpha reply")).toBe(false)
    // The transcript swap went out as a reset op with a monotonically increasing revision.
    const reset = sent.find(
      (event): event is Extract<DesktopEvent, { type: "transcript" }> =>
        event.type === "transcript" && event.ops.some((op) => op.op === "reset"),
    )
    expect(reset).toBeTruthy()
    expect(reset && reset.revision > revisionBefore).toBe(true)
    // GUI relaunches resume the last workspace.
    expect((await loadLocalSettings()).lastWorkspace).toBe(resolve(otherCwd))
    await runtime.shutdown()
  })

  it("refuses to switch during active work and leaves the current workspace running", async () => {
    const { runtime, cwd, otherCwd } = await setup()
    let release: () => void = () => {}
    mocks.executeTurn.mockImplementation(
      () =>
        new Promise<TurnResult>(
          (resolveTurn) => (release = () => resolveTurn({ status: "interrupted", messages: [], details: {} })),
        ),
    )
    await runtime.sendPrompt("long alpha turn")
    await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(true))

    const result = await runtime.switchWorkspace(otherCwd)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/Finish the current work/)
    expect((await runtime.snapshot()).workspace.path).toBe(resolve(cwd))

    release()
    await runtime.shutdown()
  })

  it("rejects a missing folder without touching the current workspace", async () => {
    const { runtime, cwd } = await setup()
    const result = await runtime.switchWorkspace(join(cwd, "does-not-exist"))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("That folder is no longer available.")
    expect((await runtime.snapshot()).workspace.path).toBe(resolve(cwd))
    await runtime.shutdown()
  })

  it("rejects a missing session in an existing folder", async () => {
    const { runtime, otherCwd } = await setup()
    const result = await runtime.switchWorkspace(otherCwd, "session_never_existed")
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("That session is no longer available.")
    await runtime.shutdown()
  })

  it("registers a legacy session's folder and then opens it", async () => {
    const { runtime, otherCwd } = await setup()
    // Simulate pre-registration history: a session dir the marker never reached.
    const foreign = await createSession({ cwd: otherCwd })
    await foreign.admitPrompt("old beta session")
    const { rm } = await import("node:fs/promises")
    const { sessionRootDirectory, defaultSessionDirectory } = await import("../../../src/storage/index.js")
    const dirName = basename(defaultSessionDirectory(otherCwd))
    await rm(join(sessionRootDirectory(), dirName, "workspace.json"))

    let snapshot = await runtime.snapshot()
    expect(snapshot.sessions.find((s) => s.id === foreign.id)?.workspacePath).toBeUndefined()

    await runtime.registerWorkspace(dirName as string, otherCwd)
    await flush()
    snapshot = await runtime.snapshot()
    expect(snapshot.sessions.find((s) => s.id === foreign.id)?.workspacePath).toBe(resolve(otherCwd))

    const opened = await runtime.switchWorkspace(otherCwd, foreign.id)
    expect(opened.ok).toBe(true)
    expect((await runtime.snapshot()).session?.id).toBe(foreign.id)
    await runtime.shutdown()
  })

  it("keeps storage identity for reopen and delete within the switched workspace", async () => {
    const { runtime, otherCwd } = await setup()
    const { appendFile, readFile } = await import("node:fs/promises")
    const { sessionRootDirectory, sessionFile } = await import("../../../src/storage/index.js")
    const legacyDirName = "oldstuff-0123456789ab"
    const legacyDir = join(sessionRootDirectory(), legacyDirName)
    await mkdir(legacyDir, { recursive: true })
    const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`
    await appendFile(
      join(legacyDir, "default.jsonl"),
      line({ seq: 1, sessionId: "default", at: new Date().toISOString(), type: "session_started", version: 1 }) +
        line({
          seq: 2,
          sessionId: "default",
          at: new Date().toISOString(),
          type: "prompt_admitted",
          promptId: "p1",
          message: { role: "user", content: "legacy conversation" },
        }),
      { mode: 0o600 },
    )
    const betaDefault = await openSessionDefault(otherCwd)
    await betaDefault.admitPrompt("beta default conversation")
    const betaOther = await createSession({ cwd: otherCwd })
    await betaOther.admitPrompt("beta other conversation")

    // Switch into beta's workspace but open the legacy session by identity.
    expect((await runtime.switchWorkspace(otherCwd, "default", legacyDirName)).ok).toBe(true)
    expect((await runtime.snapshot()).entries.some((e) => e.text === "legacy conversation")).toBe(true)

    // Select away to beta's other session, then back with the identity — the legacy conversation must return…
    expect((await runtime.selectSession(betaOther.id)).ok).toBe(true)
    expect((await runtime.snapshot()).entries.some((e) => e.text === "beta other conversation")).toBe(true)
    expect((await runtime.selectSession("default", legacyDirName)).ok).toBe(true)
    expect((await runtime.snapshot()).entries.some((e) => e.text === "legacy conversation")).toBe(true)

    // …and deleting it must not touch beta's own "default" file.
    expect((await runtime.deleteSession("default", legacyDirName)).ok).toBe(true)
    const surviving = await readFile(sessionFile({ cwd: otherCwd }, "default"), "utf8")
    expect(surviving).toContain("beta default conversation")
    await runtime.shutdown()
  })

  it("loads the destination workspace's project instructions", async () => {
    const { runtime, otherCwd } = await setup()
    const { writeFile } = await import("node:fs/promises")
    await writeFile(join(otherCwd, "AGENTS.md"), "Beta project rules")

    const result = await runtime.switchWorkspace(otherCwd)
    expect(result.ok).toBe(true)
    expect(runtime.app.projectContext.some((file) => file.path.endsWith("AGENTS.md"))).toBe(true)
    await runtime.shutdown()
  })
})

describe("workspace switch failure safety", () => {
  it("a destination session held elsewhere refuses before any commitment — the current workspace survives", async () => {
    const { runtime, cwd, otherCwd } = await setup()
    const foreign = await createSession({ cwd: otherCwd })
    await foreign.admitPrompt("beta session in use")

    // Another instance (TUI or a second GUI) holds the destination session's write lock.
    const otherApp = await Application.create({ cwd: otherCwd })
    expect(await otherApp.sessions.select(foreign.id)).toBe("loaded")

    const result = await runtime.switchWorkspace(otherCwd, foreign.id)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("That session is open in another Otis window.")

    // The GUI must still be in Alpha, fully functional — not half-switched.
    expect((await runtime.snapshot()).workspace.path).toBe(resolve(cwd))
    mocks.executeTurn.mockImplementation(turnEvents("still alpha"))
    await runtime.sendPrompt("are you alive")
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).entries.some((e) => e.text === "still alpha")).toBe(true),
    )
    await otherApp.shutdown()
    await runtime.shutdown()
  })

  it("refuses a second switch while one is in flight", async () => {
    const { runtime, cwd, otherCwd } = await setup()
    const gamma = join(cwd, "..", "gamma")
    await mkdir(gamma, { recursive: true })

    const first = runtime.switchWorkspace(otherCwd)
    const second = await runtime.switchWorkspace(gamma)
    expect(second.ok).toBe(false)
    expect(second.ok === false && second.reason).toBe("A workspace switch is already in progress.")
    expect((await first).ok).toBe(true)
    expect((await runtime.snapshot()).workspace.path).toBe(resolve(otherCwd))
    await runtime.shutdown()
  })

  it("opens located history by storage identity, never by the picked folder's duplicate ids", async () => {
    const { runtime, cwd, otherCwd } = await setup()
    // Legacy history from a forgotten folder, still using the default id…
    const { appendFile } = await import("node:fs/promises")
    const { sessionRootDirectory } = await import("../../../src/storage/index.js")
    const legacyDir = join(sessionRootDirectory(), "oldstuff-0123456789ab")
    await mkdir(legacyDir, { recursive: true })
    const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`
    await appendFile(
      join(legacyDir, "default.jsonl"),
      line({ seq: 1, sessionId: "default", at: new Date().toISOString(), type: "session_started", version: 1 }) +
        line({
          seq: 2,
          sessionId: "default",
          at: new Date().toISOString(),
          type: "prompt_admitted",
          promptId: "p1",
          message: { role: "user", content: "the original legacy conversation" },
        }),
      { mode: 0o600 },
    )
    // …while the folder the user points at has its own, different "default" session.
    const beta = await openSessionDefault(otherCwd)
    await beta.admitPrompt("beta's own default conversation")

    const registered = await runtime.registerWorkspace("oldstuff-0123456789ab", otherCwd)
    expect(registered.ok).toBe(true)
    const opened = await runtime.switchWorkspace(otherCwd, "default", "oldstuff-0123456789ab")
    expect(opened.ok).toBe(true)
    await flush()

    const snapshot = await runtime.snapshot()
    expect(snapshot.entries.some((e) => e.text === "the original legacy conversation")).toBe(true)
    expect(snapshot.entries.some((e) => e.text === "beta's own default conversation")).toBe(false)
    expect(cwd).toBeTruthy()
    await runtime.shutdown()
  })
})

async function openSessionDefault(cwd: string) {
  const { openSession } = await import("../../../src/storage/index.js")
  return openSession({ cwd, sessionId: "default" })
}
