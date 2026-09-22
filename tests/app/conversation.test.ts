import { beforeEach, describe, expect, it, vi } from "vitest"
import { ArtifactStore } from "../../src/app/artifacts.js"
import { Conversation, type ConversationHooks } from "../../src/app/conversation.js"
import { ModelHost } from "../../src/app/models.js"
import { SessionCoordinator } from "../../src/app/sessions.js"
import { SubagentTraces } from "../../src/app/subagents.js"
import { TranscriptStore } from "../../src/app/transcript.js"
import type { TurnResult, TurnRunnerOptions } from "../../src/app/turn-runner.js"
import type { AgentEvent } from "../../src/core/agent.js"
import type { ChatMessage, UserChatMessage } from "../../src/inference/types.js"
import { createPermissionPolicy } from "../../src/permissions/policy.js"
import type { ParallelClient } from "../../src/web/client.js"
import { useOtisHome } from "./support/otis-home.js"

const mocks = vi.hoisted(() => ({ executeTurn: vi.fn() }))
vi.mock("../../src/app/turn-runner.js", () => ({ executeTurn: mocks.executeTurn }))

const isolate = useOtisHome()

beforeEach(() => {
  mocks.executeTurn.mockReset()
})

const hi: UserChatMessage = { role: "user", content: "hi" }

function sink() {
  return {
    renderTranscript: vi.fn(),
    renderSubagents: vi.fn(),
    setPhase: vi.fn(),
    startBusy: vi.fn(),
    stopBusy: vi.fn(),
  }
}

function hooks(): ConversationHooks {
  return {
    sink: sink(),
    debug: false,
    onContext: () => {},
    onDiff: () => {},
    onPermissionRequest: async () => true,
    onCompletion: () => {},
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
  })
  return { conversation, sessions, transcript, artifacts }
}

describe("Conversation turns", () => {
  it("keeps recovery in the normal working phase without adding a retry label or error to chat", async () => {
    const { conversation, transcript } = await setup()
    const observer = sink()
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        await options.onEvent?.({ type: "model", phase: "retry" })
        expect(observer.setPhase).toHaveBeenLastCalledWith("working")
        await options.onEvent?.({ type: "delta", text: "Recovered" })
        await options.onEvent?.({ type: "complete", messages: [] })
        return { status: "complete", messages: [], details: {} }
      },
    )
    await conversation.start(hi, { ...hooks(), sink: observer })
    expect(observer.startBusy).toHaveBeenCalled()
    expect(observer.setPhase).toHaveBeenLastCalledWith("working")
    expect(transcript.entries.map((entry) => entry.text)).toEqual(["hi", "Recovered"])
  })

  it("projects streamed text onto the transcript and notifies the sink", async () => {
    const { conversation, transcript } = await setup()
    const observer = sink()
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

    const result = await conversation.start(hi, { ...hooks(), sink: observer })

    expect(result.status).toBe("complete")
    expect(transcript.history).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    ])
    expect(
      transcript.entries.some((entry) => entry.speaker === "Otis" && entry.text === "Hello"),
    ).toBe(true)
    expect(observer.setPhase).toHaveBeenCalledWith("working")
    expect(observer.startBusy).toHaveBeenCalled()
    expect(observer.stopBusy).toHaveBeenCalled()
    expect(observer.renderTranscript).toHaveBeenCalled()
  })

  it("preserves scrollback while replacing model context at a compaction checkpoint", async () => {
    const { conversation, transcript } = await setup()
    transcript.loadMessages([{ role: "user", content: "old" }])
    const observer = sink()
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

    await conversation.start(hi, { ...hooks(), sink: observer })

    expect(transcript.history).not.toContainEqual({ role: "user", content: "old" })
    expect(transcript.entries[0].text).toBe("old")
    expect(transcript.entries.some((entry) => entry.text.includes("Summary."))).toBe(false)
    expect(observer.startBusy).toHaveBeenCalled()
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

    await conversation.start(hi, hooks())

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
    await conversation.start(hi, hooks())
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

    const started = conversation.start({ role: "user", content: "hello" }, hooks())
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

    const started = conversation.start({ role: "user", content: "first" }, hooks())
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
    await conversation.start(queued, hooks())
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

    const first = conversation.start({ role: "user", content: "first" }, hooks())
    await vi.waitFor(() => expect(conversation.busy).toBe(true))
    const queued = await conversation.queue({ role: "user", content: "second" })
    conversation.cancel()
    await first

    const second = conversation.start(queued, hooks())
    await vi.waitFor(() => expect(conversation.busy).toBe(true))
    await expect(
      conversation.steer({ role: "user", content: "steer this" }, () => {}),
    ).resolves.toBe("steered")
    conversation.cancel()
    await second
  })

  it("does not execute or announce a turn when its start cannot be recorded", async () => {
    const { conversation, sessions, transcript } = await setup()
    const session = await sessions.ensure()
    vi.spyOn(session, "startTurn").mockRejectedValueOnce(new Error("disk full"))
    const onReady = vi.fn()
    const result = await conversation.start(
      { role: "user", content: "work" },
      { ...hooks(), onReady },
    )
    expect(result.status).toBe("error")
    expect(onReady).not.toHaveBeenCalled()
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
