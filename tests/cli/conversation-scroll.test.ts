import type { ScrollBoxRenderable } from "@opentui/core"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ArtifactStore } from "../../src/app/artifacts.js"
import { Conversation, PermissionBroker } from "../../src/app/conversation.js"
import { GatedInferenceClient, InferenceGate } from "../../src/app/models.js"
import { SessionCoordinator } from "../../src/app/sessions.js"
import { SubagentTraces } from "../../src/app/subagents.js"
import { TranscriptStore } from "../../src/app/transcript.js"
import type { TurnResult, TurnRunnerOptions } from "../../src/app/turn-runner.js"
import type { ChatUI } from "../../src/cli/ui/types.js"
import type { AgentEvent } from "../../src/core/agent.js"
import type { ChatMessage, InferenceClient } from "../../src/inference/types.js"
import { createPermissionPolicy } from "../../src/permissions/policy.js"
import type { ParallelClient } from "../../src/web/client.js"
import { useOtisHome } from "../app/support/otis-home.js"
import { useChatHarness } from "./support/chat-ui-harness.js"

const mocks = vi.hoisted(() => ({ executeTurn: vi.fn() }))
vi.mock("../../src/app/turn-runner.js", () => ({ executeTurn: mocks.executeTurn }))

const reasoningScript: AgentEvent[] = [
  { type: "model", phase: "start" },
  {
    type: "reasoning",
    phase: "start",
    reasoningId: "reasoning-1",
    field: "reasoning_content",
    startedAt: "2026-08-11T00:00:00.000Z",
  },
  ...Array.from(
    { length: 6 },
    (_, index): AgentEvent => ({
      type: "reasoning",
      phase: "delta",
      reasoningId: "reasoning-1",
      text: `reasoning chunk ${index}\n`,
    }),
  ),
  {
    type: "reasoning",
    phase: "end",
    reasoningId: "reasoning-1",
    endedAt: "2026-08-11T00:00:01.000Z",
    durationMs: 1_000,
  },
]

/** The subset of the interactive app's event mapping that drives the transcript view. */
function follow(
  conversation: Conversation,
  ui: ChatUI,
  transcript: TranscriptStore,
  subagents: SubagentTraces,
) {
  conversation.subscribe((event) => {
    if (event.type === "render")
      ui.renderTranscript(
        transcript.entries,
        event.scrollToBottom ? { scrollToBottom: true } : undefined,
      )
    else if (event.type === "subagents") ui.renderSubagents(subagents.all)
    else if (event.type === "phase") ui.setAgentPhase(event.phase)
    else if (event.type === "indicator") {
      if (event.active) ui.startBusyIndicator()
      else ui.stopBusyIndicator()
    }
  })
}

describe("conversation scrolling", () => {
  const setup = useChatHarness()
  const isolate = useOtisHome()

  beforeEach(() => {
    mocks.executeTurn.mockReset()
  })

  async function startTurn(
    harness: { ui: ChatUI },
    transcript: TranscriptStore,
    subagents: SubagentTraces,
  ) {
    const cwd = await isolate("otis-scroll-")
    const client: InferenceClient = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }
    const gate = new InferenceGate()
    const sessions = new SessionCoordinator({
      client: () => client,
      cwd,
      transcript,
      subagents,
      isBusy: () => false,
      isExiting: () => false,
    })
    const conversation: Conversation = new Conversation({
      sessions,
      transcript,
      subagents,
      webClient: {} as ParallelClient,
      cwd,
      serving: () => ({
        client: new GatedInferenceClient(client, gate, conversation.id),
        provider: "fireworks",
        autoCompactAtTokens: 100_000,
      }),
      projectContext: () => [],
      skills: () => ({ skills: [], byName: new Map() }),
      permissionPolicy: () => createPermissionPolicy({ cwd, mode: "auto" }),
      broker: new PermissionBroker(),
      isExiting: () => false,
      artifacts: new ArtifactStore(cwd),
      gate: () => undefined,
    })
    follow(conversation, harness.ui, transcript, subagents)
    await conversation.start({ role: "user", content: "hi" })
  }

  async function fillTranscript(
    harness: Awaited<ReturnType<ReturnType<typeof useChatHarness>>>,
    transcript: TranscriptStore,
  ) {
    for (let index = 0; index < 40; index += 1) {
      transcript.addAssistantMessage(`filler message ${index}\nwith extra lines\nof content`)
    }
    harness.ui.showChatLayout()
    harness.ui.renderTranscript(transcript.entries, { scrollToBottom: true })
    await harness.renderOnce()
  }

  function mockReasoningTurn(harness: Awaited<ReturnType<ReturnType<typeof useChatHarness>>>) {
    mocks.executeTurn.mockImplementation(
      async (options: TurnRunnerOptions): Promise<TurnResult> => {
        for (const event of reasoningScript) {
          await options.onEvent?.(event)
          await harness.renderOnce()
        }
        const messages: ChatMessage[] = [
          { role: "assistant", content: [{ type: "text", text: "answer" }] },
        ]
        await options.onEvent?.({ type: "complete", messages })
        return { status: "complete", messages, details: {} }
      },
    )
  }

  it("does not yank the transcript back to the bottom while reasoning streams", async () => {
    const harness = await setup()
    const transcript = new TranscriptStore()
    const subagents = new SubagentTraces()
    await fillTranscript(harness, transcript)
    mockReasoningTurn(harness)

    const messages = harness.get<ScrollBoxRenderable>("messages")
    messages.scrollTo(0)
    await harness.renderOnce()
    expect(messages.scrollTop).toBe(0)

    await startTurn(harness, transcript, subagents)
    await harness.renderOnce()

    expect(messages.scrollTop).toBe(0)
  })

  it("keeps following new content when the user is already at the bottom", async () => {
    const harness = await setup({ thinkingVisible: true })
    const transcript = new TranscriptStore()
    const subagents = new SubagentTraces()
    await fillTranscript(harness, transcript)
    mockReasoningTurn(harness)

    const messages = harness.get<ScrollBoxRenderable>("messages")
    await startTurn(harness, transcript, subagents)
    await harness.renderOnce()

    const maxScrollTop = messages.scrollHeight - messages.viewport.height
    expect(messages.scrollTop).toBe(maxScrollTop)
  })
})
