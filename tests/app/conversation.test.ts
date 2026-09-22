import { beforeEach, describe, expect, it, vi } from "vitest"
import { ArtifactStore } from "../../src/app/artifacts.js"
import { Conversation, type ConversationEvent } from "../../src/app/conversation.js"
import { ModelHost } from "../../src/app/models.js"
import { SessionCoordinator } from "../../src/app/sessions.js"
import { SubagentTraces } from "../../src/app/subagents.js"
import { TranscriptStore } from "../../src/app/transcript.js"
import type { TurnResult, TurnRunnerOptions } from "../../src/app/turn-runner.js"
import type { AgentEvent } from "../../src/core/agent.js"
import { compactionSummaryMessage, isCompactionSummary } from "../../src/core/compaction.js"
import type { ChatMessage, UserChatMessage } from "../../src/inference/types.js"
import { createPermissionPolicy } from "../../src/permissions/policy.js"
import type { ParallelClient } from "../../src/web/client.js"
import { summaryFixture } from "../support/compaction.js"
import { useOtisHome } from "./support/otis-home.js"

const mocks = vi.hoisted(() => ({ executeTurn: vi.fn() }))
vi.mock("../../src/app/turn-runner.js", () => ({ executeTurn: mocks.executeTurn }))

const isolate = useOtisHome()

beforeEach(() => {
  mocks.executeTurn.mockReset()
})

const hi: UserChatMessage = { role: "user", content: "hi" }

/** Records the conversation's stream; `phases` and `indicators` are the ordered transitions. */
function observe(conversation: Conversation) {
  const events: ConversationEvent[] = []
  conversation.subscribe((event) => events.push(event))
  return {
    events,
    get phases() {
      return events.flatMap((event) => (event.type === "phase" ? [event.phase] : []))
    },
    get indicators() {
      return events.flatMap((event) => (event.type === "indicator" ? [event.active] : []))
    },
    has: (type: ConversationEvent["type"]) => events.some((event) => event.type === type),
  }
}

async function setup() {
  const cwd = await isolate("otis-conversation-")
  const transcript = new TranscriptStore()
  const subagents = new SubagentTraces()
  const models = new ModelHost()
  models.client = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }
  models.selectedProvider = "fireworks"
  const artifacts = new ArtifactStore(cwd)
  const sessions = new SessionCoordinator({
    client: () => models.client,
    cwd,
    transcript,
    subagents,
    isBusy: () => false,
    isExiting: () => false,
  })
  const conversation = new Conversation({
    sessions,
    transcript,
    subagents,
    webClient: {} as ParallelClient,
    cwd,
    models,
    projectContext: () => [],
    skills: () => ({ skills: [], byName: new Map() }),
    permissionPolicy: () => createPermissionPolicy({ cwd, mode: "auto" }),
    isExiting: () => false,
    artifacts,
    gate: () => undefined,
  })
  return { conversation, sessions, transcript, artifacts, models }
}

const reply = (text: string): ChatMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
})
const estimate = (messages: ChatMessage[]) => Math.ceil(JSON.stringify(messages).length / 4)

describe("Conversation turns", () => {
  it("keeps recovery in the normal working phase without adding a retry label or error to chat", async () => {
    const { conversation, transcript } = await setup()
    const observer = observe(conversation)
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        await options.onEvent?.({ type: "model", phase: "retry" })
        expect(observer.phases.at(-1)).toBe("working")
        await options.onEvent?.({ type: "delta", text: "Recovered" })
        await options.onEvent?.({ type: "complete", messages: [] })
        return { status: "complete", messages: [], details: {} }
      },
    )
    await conversation.start(hi)
    expect(observer.indicators).toContain(true)
    expect(observer.phases.at(-1)).toBe("working")
    expect(transcript.entries.map((entry) => entry.text)).toEqual(["hi", "Recovered"])
  })

  it("projects streamed text onto the transcript and notifies the sink", async () => {
    const { conversation, transcript } = await setup()
    const observer = observe(conversation)
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        const events: AgentEvent[] = [
          { type: "model", phase: "start" },
          { type: "delta", text: "Hello" },
          {
            type: "complete",
            messages: [{ role: "assistant", content: [{ type: "text", text: "Hello" }] }],
          },
        ]
        for (const event of events) await options.onEvent?.(event)
        const messages: ChatMessage[] = [
          { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        ]
        return { status: "complete", messages, details: {} }
      },
    )

    const result = await conversation.start(hi)

    expect(result.status).toBe("complete")
    expect(transcript.history).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    ])
    expect(
      transcript.entries.some((entry) => entry.speaker === "Otis" && entry.text === "Hello"),
    ).toBe(true)
    expect(observer.phases).toContain("working")
    expect(observer.indicators).toEqual([true, false])
    expect(observer.has("render")).toBe(true)
    expect(observer.has("admitted")).toBe(true)
  })

  it("preserves scrollback while replacing model context at a compaction checkpoint", async () => {
    const { conversation, transcript } = await setup()
    transcript.loadMessages([{ role: "user", content: "old" }])
    const observer = observe(conversation)
    const kept: ChatMessage[] = [{ role: "user", content: "kept" }]
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        await options.onEvent?.({ type: "compaction", phase: "start" })
        await options.onEvent?.({
          type: "compaction",
          phase: "complete",
          summary: "Summary.",
          keptMessages: kept,
          messages: [],
        })
        await options.onEvent?.({
          type: "complete",
          messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
        })
        return {
          status: "complete",
          messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
          details: {},
        }
      },
    )

    await conversation.start(hi)

    expect(transcript.history).not.toContainEqual({ role: "user", content: "old" })
    expect(transcript.entries[0].text).toBe("old")
    expect(transcript.entries.some((entry) => entry.text.includes("Summary."))).toBe(false)
    expect(observer.indicators).toContain(true)
  })

  it("opens a previewable file from the shared tool event path", async () => {
    const { conversation, transcript, artifacts } = await setup()
    mocks.executeTurn.mockImplementation(async (turn: TurnRunnerOptions): Promise<TurnResult> => {
      await turn.onEvent?.({
        type: "tool",
        phase: "start",
        toolCallId: "read_1",
        name: "read",
        activityKind: "file_read",
        label: "Reading file: resume.md",
      })
      await turn.onEvent?.({
        type: "tool",
        phase: "end",
        toolCallId: "read_1",
        name: "read",
        activityKind: "file_read",
        label: "Reading file: resume.md",
        artifact: { source: "workspace", path: "resume.md", kind: "markdown" },
        outcome: "completed",
      })
      await turn.onEvent?.({ type: "complete", messages: [] })
      return { status: "complete", messages: [], details: {} }
    })

    await conversation.start(hi)

    expect(artifacts.metadata).toMatchObject({
      path: "resume.md",
      kind: "markdown",
      editable: true,
    })
    expect(transcript.entries.find((entry) => entry.toolCallId === "read_1")?.artifact).toEqual({
      source: "workspace",
      path: "resume.md",
      kind: "markdown",
    })
  })

  it.each([
    "complete",
    "interrupted",
    "error",
  ] as const)("updates Canvas live and reveals only the final artifact when a turn ends with %s", async (status) => {
    const { conversation, transcript, artifacts } = await setup()
    const artifact = { source: "workspace" as const, path: "brief.md", kind: "markdown" as const }
    mocks.executeTurn.mockImplementation(async (turn: TurnRunnerOptions): Promise<TurnResult> => {
      for (const toolCallId of ["write_1", "write_2"]) {
        const tool = {
          type: "tool" as const,
          toolCallId,
          name: "write" as const,
          activityKind: "file_write" as const,
          label: "Writing brief.md",
        }
        await turn.onEvent?.({ ...tool, phase: "start" })
        await turn.onEvent?.({ ...tool, phase: "end", outcome: "completed", artifact })
        expect(artifacts.metadata?.path).toBe("brief.md")
        expect(transcript.entries.some((entry) => entry.artifactDisplay === "ready")).toBe(false)
      }
      return status === "error"
        ? { status, message: "Provider failed", messages: [], details: {} }
        : { status, messages: [], details: {} }
    })
    await conversation.start(hi)
    expect(
      transcript.entries
        .filter((entry) => entry.artifactDisplay === "ready")
        .map((entry) => entry.toolCallId),
    ).toEqual(["write_2"])
    expect(transcript.entries.filter((entry) => entry.artifact)).toHaveLength(2)
  })
})

describe("Conversation", () => {
  it("admits, persists, and can cancel an active turn", async () => {
    const { conversation, sessions } = await setup()
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        const signal = options.agent.signal
        if (!signal) throw new Error("expected abort signal")
        await abort(signal)
        return { status: "interrupted", messages: [], details: {} }
      },
    )

    const started = conversation.start({ role: "user", content: "hello" })
    await vi.waitFor(() => expect(conversation.busy).toBe(true))
    conversation.cancel()
    await conversation.wait()
    expect(conversation.busy).toBe(false)
    expect((await started).status).toBe("interrupted")
    expect(sessions.current).toBeDefined()
  })

  it("queues a prompt while a turn is running", async () => {
    const { conversation, transcript, sessions } = await setup()
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        const signal = options.agent.signal
        if (!signal) throw new Error("expected abort signal")
        await abort(signal)
        return { status: "interrupted", messages: [], details: {} }
      },
    )

    const started = conversation.start({ role: "user", content: "first" })
    await vi.waitFor(() => expect(conversation.busy).toBe(true))
    await conversation.queue({ role: "user", content: "next" })
    const queued = conversation.takeQueued()
    expect(queued?.admission.message).toEqual({ role: "user", content: "next" })
    expect(transcript.entries.some((entry) => entry.delivery === "queued")).toBe(true)
    expect(
      sessions.current?.events.some(
        (event) => event.type === "turn_started" && event.promptId === queued?.admission.promptId,
      ),
    ).toBe(false)
    conversation.cancel()
    await started

    if (!queued) throw new Error("Expected a queued prompt")
    mocks.executeTurn.mockImplementationOnce(async () => {
      expect(sessions.current?.events.at(-1)).toMatchObject({
        type: "turn_started",
        promptId: queued.admission.promptId,
      })
      return { status: "complete", messages: [], details: {} }
    })
    await conversation.start(queued)
    expect(sessions.current?.events.filter((event) => event.type === "turn_started")).toHaveLength(
      2,
    )
  })

  it("accepts steering on a queued turn that has already been admitted", async () => {
    const { conversation } = await setup()
    mocks.executeTurn
      .mockImplementationOnce(async (options: TurnRunnerOptions): Promise<TurnResult> => {
        const signal = options.agent.signal
        if (!signal) throw new Error("expected abort signal")
        await abort(signal)
        return { status: "interrupted", messages: [], details: {} }
      })
      .mockImplementationOnce(async (options: TurnRunnerOptions): Promise<TurnResult> => {
        const signal = options.agent.signal
        if (!signal) throw new Error("expected abort signal")
        await abort(signal)
        return { status: "interrupted", messages: [], details: {} }
      })

    const first = conversation.start({ role: "user", content: "first" })
    await vi.waitFor(() => expect(conversation.busy).toBe(true))
    const queued = await conversation.queue({ role: "user", content: "second" })
    conversation.cancel()
    await first

    const second = conversation.start(queued)
    await vi.waitFor(() => expect(conversation.busy).toBe(true))
    await expect(conversation.steer({ role: "user", content: "steer this" })).resolves.toBe(
      "steered",
    )
    conversation.cancel()
    await second
  })

  it("keeps a failed prompt out of model history so later prompts and compaction still work", async () => {
    const { conversation, transcript, sessions, models } = await setup()
    const huge: UserChatMessage = { role: "user", content: "x".repeat(50_000) }
    const message =
      "The latest input and fixed context leave no room for a compaction summary. Increase the server context or reduce the input or project context."
    mocks.executeTurn.mockImplementationOnce(
      async (): Promise<TurnResult> => ({
        status: "error",
        message,
        messages: [huge],
        details: {},
      }),
    )
    expect((await conversation.start(huge)).status).toBe("error")
    expect(transcript.history).toEqual([])
    expect(transcript.entries.map((entry) => entry.text)).toEqual([
      huge.content,
      `Error: ${message}`,
    ])

    const long = reply("detail ".repeat(2_000))
    mocks.executeTurn
      .mockImplementationOnce(async (options: TurnRunnerOptions): Promise<TurnResult> => {
        expect(options.history).toEqual([])
        return { status: "complete", messages: [hi, long], details: {} }
      })
      .mockImplementationOnce(async (options: TurnRunnerOptions): Promise<TurnResult> => {
        expect(options.history).toEqual([hi, long])
        return {
          status: "complete",
          messages: [{ role: "user", content: "more" }, reply("done")],
          details: {},
        }
      })
    await conversation.start(hi)
    await conversation.start({ role: "user", content: "more" })
    const session = sessions.current
    if (!session) throw new Error("Expected a session")
    expect(session.replayMessages()).toEqual(transcript.history)
    expect(session.replayTranscript().messages).toEqual([huge, ...transcript.history])

    if (!models.client) throw new Error("Expected a client")
    models.client.streamChat = vi.fn(async function* () {
      yield { type: "text_delta" as const, text: summaryFixture("Earlier detail summarized.") }
    })
    await conversation.compact(undefined, estimate)
    expect(transcript.entries.at(-1)?.text).not.toContain("Compaction failed")
    expect(transcript.history[0]).toEqual(
      compactionSummaryMessage(summaryFixture("Earlier detail summarized.")),
    )
    expect(transcript.history).not.toContainEqual(huge)
  })

  it("says nothing to compact for a single exchange instead of failing", async () => {
    const { conversation, transcript, models } = await setup()
    mocks.executeTurn.mockImplementationOnce(
      async (): Promise<TurnResult> => ({
        status: "complete",
        messages: [hi, reply("hello")],
        details: {},
      }),
    )
    await conversation.start(hi)
    if (!models.client) throw new Error("Expected a client")
    const streamChat = vi.fn(async function* () {
      yield { type: "text_delta" as const, text: summaryFixture() }
    })
    models.client.streamChat = streamChat
    await conversation.compact(undefined, estimate)
    expect(transcript.entries.at(-1)?.text).toBe("Nothing to compact yet.")
    expect(streamChat).not.toHaveBeenCalled()
    expect(transcript.history).toEqual([hi, reply("hello")])
  })

  it("checkpoints /compact before a queued prompt so that prompt survives a reload", async () => {
    const { conversation, transcript, sessions, models } = await setup()
    const long = reply("detail ".repeat(2_000))
    mocks.executeTurn.mockImplementationOnce(
      async (): Promise<TurnResult> => ({ status: "complete", messages: [hi, long], details: {} }),
    )
    await conversation.start(hi)
    mocks.executeTurn.mockImplementationOnce(
      async (): Promise<TurnResult> => ({
        status: "complete",
        messages: [{ role: "user", content: "again" }, reply("ok")],
        details: {},
      }),
    )
    await conversation.start({ role: "user", content: "again" })
    const queued = await conversation.queue({ role: "user", content: "later" })
    const session = sessions.current
    if (!session || !models.client) throw new Error("Expected a session and a client")
    const admittedSeq = session.events.find(
      (event) => event.type === "prompt_admitted" && event.promptId === queued.admission.promptId,
    )?.seq
    models.client.streamChat = vi.fn(async function* () {
      yield { type: "text_delta" as const, text: summaryFixture("First turn summarized.") }
    })
    await conversation.compact(undefined, estimate)
    const compacted = session.events.at(-1)
    expect(compacted).toMatchObject({ type: "compacted", throughSeq: (admittedSeq ?? 0) - 1 })
    expect(transcript.history.some(isCompactionSummary)).toBe(true)

    const next = conversation.takeQueued()
    if (!next) throw new Error("Expected the queued prompt")
    mocks.executeTurn.mockImplementationOnce(
      async (): Promise<TurnResult> => ({
        status: "complete",
        messages: [next.admission.message, reply("later done")],
        details: {},
      }),
    )
    await conversation.start(next)
    expect(session.replayMessages()).toEqual(transcript.history)
    expect(session.replayMessages().slice(-2)).toEqual([
      next.admission.message,
      reply("later done"),
    ])
  })

  it("does not execute or announce a turn when its start cannot be recorded", async () => {
    const { conversation, sessions, transcript } = await setup()
    const session = await sessions.ensure()
    vi.spyOn(session, "startTurn").mockRejectedValueOnce(new Error("disk full"))
    const onReady = vi.fn()
    const observer = observe(conversation)
    const result = await conversation.start({ role: "user", content: "work" }, onReady)
    expect(result.status).toBe("error")
    expect(onReady).not.toHaveBeenCalled()
    expect(observer.has("admitted")).toBe(false)
    expect(mocks.executeTurn).not.toHaveBeenCalled()
    expect(conversation.busy).toBe(false)
    expect(transcript.entries.at(-1)?.text).toBe("Error: disk full")
  })
})

function abort(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}
