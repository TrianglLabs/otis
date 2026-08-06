import { randomUUID } from "node:crypto"
import type {
  AssistantContentPart,
  ChatToolCall,
  OpenAICompatibleReasoningField,
  ReasoningContentPart,
  ReasoningTraceEvent,
} from "../inference/types.js"

type AssistantResponseBuilderOptions = {
  createId?: () => string
  now?: () => Date
}

export class AssistantResponseBuilder {
  readonly content: AssistantContentPart[] = []
  readonly toolCalls: ChatToolCall[] = []
  readonly #createId: () => string
  readonly #now: () => Date
  #activeReasoning?: ReasoningContentPart & { id: string; startedAt: string }

  constructor(options: AssistantResponseBuilderOptions = {}) {
    this.#createId = options.createId ?? randomUUID
    this.#now = options.now ?? (() => new Date())
  }

  appendText(text: string): ReasoningTraceEvent[] {
    const events = this.finishReasoning()
    const previous = this.content.at(-1)
    if (previous?.type === "text") previous.text += text
    else this.content.push({ type: "text", text })
    return events
  }

  appendReasoning(text: string, field: OpenAICompatibleReasoningField): ReasoningTraceEvent[] {
    const events: ReasoningTraceEvent[] = []
    if (this.#activeReasoning?.field !== field) events.push(...this.finishReasoning())

    if (!this.#activeReasoning) {
      const startedAt = this.#now().toISOString()
      this.#activeReasoning = {
        type: "reasoning",
        id: this.#createId(),
        text: "",
        field,
        startedAt,
      }
      this.content.push(this.#activeReasoning)
      events.push({
        type: "reasoning",
        phase: "start",
        reasoningId: this.#activeReasoning.id,
        field,
        startedAt,
      })
    }

    this.#activeReasoning.text += text
    events.push({ type: "reasoning", phase: "delta", reasoningId: this.#activeReasoning.id, text })
    return events
  }

  appendToolCall(toolCall: ChatToolCall): ReasoningTraceEvent[] {
    const events = this.finishReasoning()
    this.toolCalls.push(toolCall)
    this.content.push({ type: "tool_call", toolCall })
    return events
  }

  finish(): ReasoningTraceEvent[] {
    return this.finishReasoning()
  }

  hasText() {
    return this.content.some((part) => part.type === "text" && part.text.trim().length > 0)
  }

  private finishReasoning(): ReasoningTraceEvent[] {
    if (!this.#activeReasoning) return []
    const endedAt = this.#now()
    this.#activeReasoning.endedAt = endedAt.toISOString()
    const event: ReasoningTraceEvent = {
      type: "reasoning",
      phase: "end",
      reasoningId: this.#activeReasoning.id,
      endedAt: this.#activeReasoning.endedAt,
      durationMs: Math.max(0, endedAt.getTime() - new Date(this.#activeReasoning.startedAt).getTime()),
    }
    this.#activeReasoning = undefined
    return [event]
  }
}
