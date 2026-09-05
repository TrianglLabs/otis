import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  Conversation,
  type ConversationHooks,
  type ConversationTurnOptions,
  runConversationTurn,
} from "../../src/app/conversation.js"
import { ModelHost } from "../../src/app/models.js"
import { SessionCoordinator } from "../../src/app/sessions.js"
import { SubagentTraces } from "../../src/app/subagents.js"
import { TranscriptStore } from "../../src/app/transcript.js"
import type { TurnResult, TurnRunnerOptions } from "../../src/app/turn-runner.js"
import type { AgentEvent } from "../../src/core/agent.js"
import type { ChatMessage } from "../../src/inference/types.js"
import { createPermissionPolicy } from "../../src/permissions/policy.js"
import { useOtisHome } from "./support/otis-home.js"

const mocks = vi.hoisted(() => ({ executeTurn: vi.fn() }))
vi.mock("../../src/app/turn-runner.js", () => ({ executeTurn: mocks.executeTurn }))

function sink() {
  return {
    renderTranscript: vi.fn(),
    renderSubagents: vi.fn(),
    setPhase: vi.fn(),
    startBusy: vi.fn(),
    stopBusy: vi.fn(),
  }
}

function turnOptions(transcript: TranscriptStore, observer = sink()): ConversationTurnOptions {
  return {
    admission: { promptId: "prompt_1", message: { role: "user", content: "hi" } },
    client: { model: "fake", streamChat: vi.fn(), complete: vi.fn() },
    webClient: {} as ConversationTurnOptions["webClient"],
    webClientModel: "fake",
    transcript,
    subagents: new SubagentTraces(),
    sink: observer,
    cwd: "/tmp",
    debug: false,
    signal: new AbortController().signal,
    projectContext: [],
    skills: { skills: [], byName: new Map() },
    tools: [],
    isExiting: () => false,
    onContext: () => {},
    onDiff: () => {},
    onUsage: () => {},
    permissionPolicy: createPermissionPolicy({ cwd: "/tmp", mode: "auto" }),
    onPermissionRequest: async () => true,
    onCompletion: () => {},
  }
}

describe("runConversationTurn", () => {
  it("projects streamed text onto the transcript and notifies the sink", async () => {
    const transcript = new TranscriptStore()
    const observer = sink()
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
      const events: AgentEvent[] = [
        { type: "model", phase: "start" },
        { type: "delta", text: "Hello" },
        { type: "complete", messages: [{ role: "assistant", content: [{ type: "text", text: "Hello" }] }] },
      ]
      for (const event of events) await options.onEvent?.(event)
      const messages: ChatMessage[] = [{ role: "assistant", content: [{ type: "text", text: "Hello" }] }]
      return { status: "complete", messages, details: {} }
    })

    const result = await runConversationTurn(turnOptions(transcript, observer))

    expect(result.status).toBe("complete")
    expect(transcript.history).toEqual([{ role: "assistant", content: [{ type: "text", text: "Hello" }] }])
    expect(transcript.entries.some((entry) => entry.speaker === "Otis" && entry.text === "Hello")).toBe(true)
    expect(observer.setPhase).toHaveBeenCalledWith("working")
    expect(observer.startBusy).toHaveBeenCalled()
    expect(observer.stopBusy).toHaveBeenCalled()
    expect(observer.renderTranscript).toHaveBeenCalled()
  })

  it("reloads the transcript from a compaction checkpoint", async () => {
    const transcript = new TranscriptStore()
    transcript.addMessages([{ role: "user", content: "old" }])
    const observer = sink()
    const kept: ChatMessage[] = [{ role: "user", content: "kept" }]
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
      await options.onEvent?.({ type: "compaction", phase: "start" })
      await options.onEvent?.({ type: "compaction", phase: "complete", summary: "Summary.", keptMessages: kept })
      await options.onEvent?.({
        type: "complete",
        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
      })
      return {
        status: "complete",
        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
        details: {},
      }
    })

    await runConversationTurn(turnOptions(transcript, observer))

    expect(transcript.history[0]).toMatchObject({ role: "user" })
    expect(transcript.entries.some((entry) => entry.text.includes("Conversation compacted"))).toBe(true)
    expect(observer.startBusy).toHaveBeenCalled()
  })
})

describe("Conversation", () => {
  const isolate = useOtisHome()

  beforeEach(() => {
    mocks.executeTurn.mockReset()
  })

  async function setup() {
    const cwd = await isolate("otis-conversation-")
    const transcript = new TranscriptStore()
    const subagents = new SubagentTraces()
    const models = new ModelHost()
    models.client = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }
    models.selectedProvider = "fireworks"
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
      webClient: {} as ConversationTurnOptions["webClient"],
      cwd,
      models,
      projectContext: () => [],
      skills: () => ({ skills: [], byName: new Map() }),
      permissionPolicy: () => createPermissionPolicy({ cwd, mode: "auto" }),
      isExiting: () => false,
    })
    return { conversation, sessions, transcript, hooks: hooks() }
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

  it("admits, persists, and can cancel an active turn", async () => {
    const { conversation, sessions } = await setup()
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
      const signal = options.agent.signal
      if (!signal) throw new Error("expected abort signal")
      await abort(signal)
      return { status: "interrupted", messages: [], details: {} }
    })

    const started = conversation.start({ role: "user", content: "hello" }, hooks())
    await vi.waitFor(() => expect(conversation.busy).toBe(true))
    conversation.cancel()
    await conversation.wait()
    expect(conversation.busy).toBe(false)
    expect((await started).status).toBe("interrupted")
    expect(sessions.current).toBeDefined()
  })

  it("queues a prompt while a turn is running", async () => {
    const { conversation, transcript } = await setup()
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
      const signal = options.agent.signal
      if (!signal) throw new Error("expected abort signal")
      await abort(signal)
      return { status: "interrupted", messages: [], details: {} }
    })

    const started = conversation.start({ role: "user", content: "first" }, hooks())
    await vi.waitFor(() => expect(conversation.busy).toBe(true))
    await conversation.queue({ role: "user", content: "next" })
    const queued = conversation.takeQueued()
    expect(queued?.admission.message).toEqual({ role: "user", content: "next" })
    expect(transcript.entries.some((entry) => entry.delivery === "queued")).toBe(true)
    conversation.cancel()
    await started
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
    await expect(conversation.steer({ role: "user", content: "steer this" }, () => {})).resolves.toBe("steered")
    conversation.cancel()
    await second
  })
})

function abort(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}
