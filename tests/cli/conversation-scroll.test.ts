import type { ScrollBoxRenderable } from "@opentui/core"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { type ConversationTurnOptions, runConversationTurn } from "../../src/app/conversation.js"
import { SubagentTraces } from "../../src/app/subagents.js"
import { TranscriptStore } from "../../src/app/transcript.js"
import type { TurnResult, TurnRunnerOptions } from "../../src/app/turn-runner.js"
import type { ChatUI } from "../../src/cli/ui/types.js"
import type { AgentEvent } from "../../src/core/agent.js"
import type { ChatMessage } from "../../src/inference/types.js"
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

function conversationSink(ui: ChatUI, transcript: TranscriptStore, subagents: SubagentTraces) {
  return {
    renderTranscript: (options?: { scrollToBottom?: boolean }) => ui.renderTranscript(transcript.entries, options),
    renderSubagents: () => ui.renderSubagents(subagents.all),
    setPhase: (phase: "thinking" | "working") => ui.setAgentPhase(phase),
    startBusy: () => ui.startBusyIndicator(),
    stopBusy: () => ui.stopBusyIndicator(),
  }
}

describe("conversation scrolling", () => {
  const setup = useChatHarness()

  beforeEach(() => {
    mocks.executeTurn.mockReset()
  })

  function turnOptions(
    harness: { ui: ChatUI },
    transcript: TranscriptStore,
    subagents: SubagentTraces,
  ): ConversationTurnOptions {
    return {
      admission: { message: { role: "user", content: "hi" } },
      transcript,
      subagents,
      sink: conversationSink(harness.ui, transcript, subagents),
      cwd: "/tmp",
      debug: false,
      signal: new AbortController().signal,
      projectContext: [],
      isExiting: () => false,
      onContext: () => {},
      onDiff: () => {},
      onUsage: () => {},
      onCompletion: () => {},
    } as unknown as ConversationTurnOptions
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
    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
      for (const event of reasoningScript) {
        await options.onEvent?.(event)
        await harness.renderOnce()
      }
      const messages: ChatMessage[] = [{ role: "assistant", content: [{ type: "text", text: "answer" }] }]
      await options.onEvent?.({ type: "complete", messages })
      return { status: "complete", messages, details: {} }
    })
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

    await runConversationTurn(turnOptions(harness, transcript, subagents))
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
    await runConversationTurn(turnOptions(harness, transcript, subagents))
    await harness.renderOnce()

    const maxScrollTop = messages.scrollHeight - messages.viewport.height
    expect(messages.scrollTop).toBe(maxScrollTop)
  })
})
