export type ChatToolCall = {
  id: string
  name: string
  arguments: string
}

export type OpenAICompatibleReasoningField = "reasoning_content" | "reasoning" | "reasoning_text"

export type ReasoningContentPart = {
  type: "reasoning"
  text: string
  field: OpenAICompatibleReasoningField
  /** Otis-owned identity and timing metadata. Optional for sessions created before reasoning traces were introduced. */
  id?: string
  startedAt?: string
  endedAt?: string
}

export type AssistantContentPart =
  | { type: "text"; text: string }
  | ReasoningContentPart
  | { type: "tool_call"; toolCall: ChatToolCall }

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: AssistantContentPart[] }
  | { role: "tool"; toolCallId: string; content: string }

export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type TokenUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string; field: OpenAICompatibleReasoningField }
  | { type: "tool_call"; toolCall: ChatToolCall }
  | { type: "usage"; usage: TokenUsage }

export type ReasoningTraceEvent =
  | {
      type: "reasoning"
      phase: "start"
      reasoningId: string
      field: OpenAICompatibleReasoningField
      startedAt: string
    }
  | { type: "reasoning"; phase: "delta"; reasoningId: string; text: string }
  | { type: "reasoning"; phase: "end"; reasoningId: string; endedAt: string; durationMs: number }

export type ContextFile = {
  path: string
  content: string
}

export type FireworksModel = {
  id: string
  displayName: string
  contextLength?: number
}

export type FireworksClientConfig = {
  apiKey: string
  model: string
  fetch?: typeof fetch
  inferenceURL?: string
}
