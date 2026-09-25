import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Application } from "../../src/app/application.js"
import type { ConversationTurnResult } from "../../src/app/conversation.js"
import { isCompactionSummary } from "../../src/core/compaction.js"
import { createDocumentAttachment } from "../../src/inference/documents.js"
import { catalogModelFromSpec } from "../../src/inference/local-catalog.js"
import { lastAssistantText } from "../../src/inference/messages.js"
import { type LocalPickerChoice, listModelPickerItems } from "../../src/inference/picker-catalog.js"
import type { UserChatMessage } from "../../src/inference/types.js"
import { saveSelectedModel } from "../../src/local/settings.js"
import {
  type CachedLocalModel,
  findCachedLocalModels,
  INTEGRATION_ENV,
  isProcessAlive,
  llamaServerPids,
  OTIS_INTEGRATION,
  recordedServer,
  stageLocalModel,
} from "../support/llama-fixtures.js"

/**
 * The real managed runtime, booted through the real Application the way the desktop drives it:
 * selection transactions, executeTurn, sessions, and the llama-server process itself. Opt in
 * with OTIS_INTEGRATION=1 on a machine that already caches a catalog model and its pinned
 * runtime; nothing is downloaded, and the cache is only ever read.
 */
const discovery = OTIS_INTEGRATION ? await findCachedLocalModels() : undefined
const cached = discovery?.models[0]
const reason = !OTIS_INTEGRATION
  ? "OTIS_INTEGRATION=1 is not set"
  : cached
    ? undefined
    : `no cached managed model with its pinned llama.cpp runtime under ${discovery?.roots.join(", ")}`
const TIMEOUT = 5 * 60 * 1000

if (reason) it.skip(`real llama-server through the Application: ${reason}`, () => {})

describe.skipIf(reason)(`real llama-server through the Application (${cached?.spec.id})`, () => {
  const model = cached as CachedLocalModel
  const originalHome = process.env.OTIS_HOME
  let home: string
  let cwd: string
  let binary: string
  let app: Application | undefined

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "otis-integration-"))
    process.env.OTIS_HOME = home
    cwd = join(home, "workspace")
    await mkdir(cwd, { recursive: true })
    binary = await stageLocalModel(home, model)
  }, 60_000)

  afterAll(async () => {
    await app?.shutdown()
    if (originalHome === undefined) delete process.env.OTIS_HOME
    else process.env.OTIS_HOME = originalHome
    await rm(home, { recursive: true, force: true })
    expect(await llamaServerPids(binary)).toEqual([])
  }, 60_000)

  /** The model's row as the pickers list it for this application's current selection. */
  async function pickerRow(application: Application) {
    const { models, selection } = application
    const items = await listModelPickerItems({
      currentModel: selection?.model.id,
      currentProvider: selection?.model.provider,
      loadStatus: models.load,
      loadedLocalModel: models.activeLocal
        ? { model: models.activeLocal.spec.id, contextLength: models.activeLocal.contextLength }
        : undefined,
    })
    const row = items.find(
      (item): item is LocalPickerChoice =>
        item.kind === "model" && item.provider === "local" && item.id === model.spec.id,
    )
    if (!row) throw new Error(`${model.spec.id} is missing from the picker`)
    return row
  }

  /** One application whose server starts once; later cases share it. */
  async function shared() {
    if (app) return app
    app = await Application.create({ cwd, env: INTEGRATION_ENV })
    expect(await app.selectModel(await pickerRow(app))).toEqual({ ok: true })
    expect(app.status()).toMatchObject({ modelState: "ready", model: { provider: "local" } })
    return app
  }

  /** Submits one prompt and returns how its turn settled. */
  async function turn(application: Application, message: UserChatMessage) {
    const settled = new Promise<ConversationTurnResult>((resolve) => {
      const unsubscribe = application.subscribe((event) => {
        if (event.type !== "settled") return
        unsubscribe()
        resolve(event.result)
      })
    })
    await application.conversation.submit(message)
    const result = await settled
    await application.conversation.idle()
    return result
  }

  const lastEntry = (application: Application) => application.transcript.entries.at(-1)?.text ?? ""

  it(
    "supersedes the saved model's startup with a selection made while it loads, leaving one server",
    async () => {
      await saveSelectedModel(catalogModelFromSpec(model.spec))
      const booting = await Application.create({ cwd, env: INTEGRATION_ENV })
      expect(booting.status()).toMatchObject({
        modelState: "starting",
        model: { provider: "local" },
      })
      const row = await pickerRow(booting)
      const startup = booting.startSavedSelection()
      await vi.waitFor(async () => expect(await llamaServerPids(binary)).toHaveLength(1), {
        timeout: 60_000,
        interval: 100,
      })
      const [first] = await llamaServerPids(binary)

      expect(await booting.selectModel(row)).toEqual({ ok: true })
      expect(await startup).toBe("superseded")
      expect(booting.status()).toMatchObject({ modelState: "ready", modelLoad: null })
      const pids = await llamaServerPids(binary)
      expect(pids).toHaveLength(1)
      expect(pids[0]).not.toBe(first)
      expect(isProcessAlive(first)).toBe(false)
      expect((await recordedServer(home)).pid).toBe(pids[0])

      await booting.shutdown()
      expect(await llamaServerPids(binary)).toEqual([])
    },
    TIMEOUT,
  )

  it(
    "answers a prompt with a non-empty completion and records its usage on the session",
    async () => {
      const application = await shared()
      const result = await turn(application, {
        role: "user",
        content: "Reply with the single word: pong",
      })
      expect(result.status).toBe("complete")
      if (result.status !== "complete") return
      expect(lastAssistantText(result.messages).trim()).not.toBe("")
      const usage = (application.sessions.current?.events ?? []).flatMap((event) =>
        event.type === "usage_recorded" && event.purpose === "agent" ? [event.usage] : [],
      )
      expect(usage.length).toBeGreaterThan(0)
      expect(usage[0].promptTokens).toBeGreaterThan(0)
      expect(usage[0].completionTokens).toBeGreaterThan(0)
    },
    TIMEOUT,
  )

  it(
    "refuses a second instance's select while the session is locked, and relocks after release",
    async () => {
      const application = await shared()
      const session = application.sessions.current
      if (!session) throw new Error("expected the shared application to have a session")
      const other = await Application.create({ cwd, env: INTEGRATION_ENV })
      try {
        expect(await other.sessions.select(session.id)).toBe("locked")
        await application.sessions.releaseLock()
        expect(await other.sessions.select(session.id)).toBe("loaded")
        expect(other.transcript.history).toEqual(application.transcript.history)
        expect(await application.sessions.relock()).toBe("locked")
        await other.sessions.releaseLock()
        expect(await application.sessions.relock()).toBe("ok")
      } finally {
        await other.shutdown()
      }
      expect(await llamaServerPids(binary)).toHaveLength(1)
    },
    TIMEOUT,
  )

  it(
    "keeps a prompt that overflows the server out of history, so the session answers and compacts",
    async () => {
      const application = await shared()
      const historyBefore = [...application.transcript.history]
      // Ideographs tokenize at about two tokens per character: 150K of them exceed the fitted
      // window (and the auto-compaction budget) while staying inside the document text limit.
      const wall = await createDocumentAttachment(
        new TextEncoder().encode(ideographs(150_000)),
        "wall.txt",
      )
      const failed = await turn(
        application,
        await application.buildPrompt("Summarize the attached file in one sentence.", [wall]),
      )
      expect(failed.status).toBe("error")
      expect(lastEntry(application)).toContain("leave no room for a compaction summary")
      expect(application.transcript.history).toEqual(historyBefore)

      const notes = await createDocumentAttachment(
        new TextEncoder().encode(prose(16_000)),
        "notes.txt",
      )
      const recovered = await turn(
        application,
        await application.buildPrompt("Reply with the single word: pong", [notes]),
      )
      expect(recovered.status).toBe("complete")
      const third = await turn(application, {
        role: "user",
        content: "Reply with the single word: ping",
      })
      expect(third.status).toBe("complete")

      await application.conversation.compact(undefined, application.contextEstimator())
      expect(lastEntry(application)).not.toContain("Compaction failed")
      expect(lastEntry(application)).not.toContain("leave no room")
      const history = application.transcript.history
      expect(isCompactionSummary(history[0])).toBe(true)
      // The summary may cite the notes by name and SHA-256, as the summarizer is asked to; the
      // overflowing prompt never reached history, so nothing of it survives to be summarized.
      expect(JSON.stringify(history)).not.toContain(wall.sha256)
      expect(JSON.stringify(history)).not.toContain('"type":"document"')
    },
    TIMEOUT,
  )

  it(
    "reports a server killed mid-session with its signal and log tail, then recovers on reselect",
    async () => {
      const application = await shared()
      const { pid } = await recordedServer(home)
      process.kill(pid, "SIGKILL")
      await vi.waitFor(
        () => expect(() => application.models.llama.assertServing()).toThrow("exited unexpectedly"),
        { timeout: 10_000 },
      )

      const failed = await turn(application, {
        role: "user",
        content: "Reply with the single word: pong",
      })
      expect(failed.status).toBe("error")
      const message = lastEntry(application)
      const lines = message.split("\n")
      expect(lines[0]).toBe("Error: The local model server exited unexpectedly (signal SIGKILL).")
      expect(lines.at(-1)).toBe("Reselect the model to restart it.")
      // The server's final log lines sit between the two: the tail is not empty.
      expect(lines.slice(1, -1).join("\n").trim()).not.toBe("")
      expect(await llamaServerPids(binary)).toEqual([])

      expect(await application.selectModel(await pickerRow(application))).toEqual({ ok: true })
      const pids = await llamaServerPids(binary)
      expect(pids).toHaveLength(1)
      expect(pids[0]).not.toBe(pid)
      const recovered = await turn(application, {
        role: "user",
        content: "Reply with the single word: pong",
      })
      expect(recovered.status).toBe("complete")
    },
    TIMEOUT,
  )
})

/** Deterministic CJK ideographs, the densest text the tokenizer sees. */
function ideographs(length: number) {
  let seed = 0x2545f491
  let text = ""
  while (text.length < length) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    text += String.fromCharCode(0x4e00 + (seed % 0x51a5))
  }
  return text
}

/** Plain, varied English filler with enough substance for a summary. */
function prose(length: number) {
  const lines: string[] = []
  for (let index = 1; lines.join("\n").length < length; index += 1) {
    lines.push(
      `Entry ${index}: the team reviewed deployment step ${index}, recorded its outcome, and named an owner.`,
    )
  }
  return lines.join("\n").slice(0, length)
}
