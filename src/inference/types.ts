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

export type ImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/bmp"
  | "image/tiff"
  | "image/x-portable-pixmap"

export type ImageContentPart = {
  type: "image"
  data: string
  mimeType: ImageMimeType
  name: string
  sizeBytes: number
}

export type UserContentPart = { type: "text"; text: string } | ImageContentPart
export type UserChatMessage = { role: "user"; content: string | UserContentPart[] }

export type ChatMessage =
  | UserChatMessage
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
  | { type: "finish"; reason: string }

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

export type ModelProvider = "fireworks" | "local" | "pair"
export type PairEngine = "ollama" | "lmstudio"

type SharedModelFields = {
  id: string
  displayName: string
  contextLength?: number
  supportsImageInput: boolean
}

export type FireworksModel = SharedModelFields & {
  provider: "fireworks"
  /** Fast serving-path ID when Fireworks publishes one for this model. */
  fastId?: string
}

export type LocalCatalogModel = {
  provider: "local"
  id: string
  displayName: string
  contextLength: number
  supportsImageInput: boolean
}

export type PairCatalogModel = {
  provider: "pair"
  id: string
  displayName: string
  baseURL: string
  engine: PairEngine
  /** Model-architecture maximum; display metadata, never a PAIR runtime budget. */
  nativeContextLength?: number
  quantization?: string
  supportsImageInput: boolean
}

export type CatalogModel = FireworksModel | LocalCatalogModel | PairCatalogModel

export function fireworksModel(fields: Omit<FireworksModel, "provider">): FireworksModel {
  return { provider: "fireworks", ...fields }
}

export function isLocalCatalogModel(model: CatalogModel): model is LocalCatalogModel {
  return model.provider === "local"
}

export function isPairCatalogModel(model: CatalogModel): model is PairCatalogModel {
  return model.provider === "pair"
}

export type InferenceClient = {
  readonly model: string
  streamChat(options: StreamChatOptions): AsyncGenerator<ChatStreamEvent>
  complete(messages: ChatMessage[], options?: CompleteOptions): Promise<string>
}

export type StreamChatOptions = {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  projectContext?: ContextFile[]
  signal?: AbortSignal
  now?: Date
  skills?: readonly import("../skills/types.js").Skill[]
}

export type CompleteOptions = {
  projectContext?: ContextFile[]
  signal?: AbortSignal
  onUsage?: (usage: TokenUsage) => void | Promise<void>
}

export type FireworksClientConfig = {
  apiKey: string
  model: string
  fetch?: typeof fetch
  inferenceURL?: string
}

export type LocalClientConfig = {
  model: string
  inferenceURL: string
  fetch?: typeof fetch
  apiKey?: string
}
