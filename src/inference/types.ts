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
  /**
   * Otis-owned identity and timing metadata. Optional for sessions created before reasoning
   * traces were introduced.
   */
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

export type DocumentKind = "text" | "pdf" | "docx"

/**
 * An immutable source document plus the text Otis derived from it for model context.
 * Keeping the source bytes and content hash makes the attachment usable by future
 * document editors and Canvas renderers without reconstructing it from flattened text.
 */
export type DocumentContentPart = {
  type: "document"
  kind: DocumentKind
  /**
   * Base64 source bytes for local persistence and future artifact rendering; provider adapters
   * must not serialize it.
   */
  data: string
  extractedText: string
  mimeType: string
  name: string
  sizeBytes: number
  sha256: string
  truncated: boolean
  pageCount?: number
}

export type AttachmentContentPart = ImageContentPart | DocumentContentPart
export type UserContentPart = { type: "text"; text: string } | AttachmentContentPart
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

export const HOSTED_PROVIDERS = ["fireworks", "together", "baseten", "primeintellect"] as const
export type HostedProvider = (typeof HOSTED_PROVIDERS)[number]
/**
 * User-managed OpenAI-compatible servers on loopback: oMLX, and any other engine the user runs.
 * Their settings keys in the config file are these ids.
 */
export const SERVER_PROVIDERS = ["omlx", "custom"] as const
export type ServerProvider = (typeof SERVER_PROVIDERS)[number]
export const SERVER_INFO: Record<ServerProvider, { name: string; defaultEndpoint: string }> = {
  omlx: { name: "oMLX", defaultEndpoint: "http://127.0.0.1:8000" },
  custom: { name: "Custom server", defaultEndpoint: "http://127.0.0.1:8080" },
}
/** A server's address and key; a model and context limit stand in for what it does not report. */
export type ServerSettings = {
  baseURL: string
  apiKey?: string
  model?: string
  contextLength?: number
}
export type ModelProvider = HostedProvider | "local" | "pair" | ServerProvider
export type PairEngine = "ollama" | "lmstudio"

/** One saved key per hosted provider; a missing entry means that provider is not set up. */
export type HostedApiKeys = Partial<Record<HostedProvider, string>>

/**
 * What a provider documents about prompts and outputs: `zero` keeps none by default, `optIn`
 * stores them until zero data retention is switched on in the account, `unknown` publishes no
 * inference retention terms. Sources are listed in docs/data-and-privacy.md.
 */
export type DataRetention = "zero" | "optIn" | "unknown"

/**
 * What a hosted provider is called, where its key and OpenAI-compatible endpoint live, the field
 * its models stream reasoning in, which is the only one it takes back in a later turn, and its
 * documented data retention.
 */
export const HOSTED_PROVIDER_INFO: Record<
  HostedProvider,
  {
    name: string
    keyEnv: string
    keyURL: string
    inferenceURL: string
    modelsURL: string
    reasoningField: OpenAICompatibleReasoningField
    dataRetention: DataRetention
  }
> = {
  fireworks: {
    name: "Fireworks",
    keyEnv: "FIREWORKS_API_KEY",
    keyURL: "https://app.fireworks.ai/api-keys",
    inferenceURL: "https://api.fireworks.ai/inference/v1/chat/completions",
    modelsURL: "https://api.fireworks.ai/v1/accounts/fireworks/models",
    reasoningField: "reasoning_content",
    dataRetention: "zero",
  },
  together: {
    name: "Together AI",
    keyEnv: "TOGETHER_API_KEY",
    keyURL: "https://api.together.ai/settings/projects/~current/api-keys",
    inferenceURL: "https://api.together.xyz/v1/chat/completions",
    modelsURL: "https://api.together.xyz/v1/models",
    reasoningField: "reasoning",
    dataRetention: "optIn",
  },
  baseten: {
    name: "Baseten",
    keyEnv: "BASETEN_API_KEY",
    keyURL: "https://app.baseten.co/settings/api_keys",
    inferenceURL: "https://inference.baseten.co/v1/chat/completions",
    modelsURL: "https://inference.baseten.co/v1/models",
    reasoningField: "reasoning_content",
    dataRetention: "zero",
  },
  primeintellect: {
    name: "Prime Intellect",
    keyEnv: "PRIME_API_KEY",
    keyURL: "https://app.primeintellect.ai/dashboard/tokens",
    inferenceURL: "https://api.pinference.ai/api/v1/chat/completions",
    modelsURL: "https://api.pinference.ai/api/v1/models",
    reasoningField: "reasoning",
    dataRetention: "unknown",
  },
}

const MODEL_PROVIDERS = [...HOSTED_PROVIDERS, "local", "pair", ...SERVER_PROVIDERS] as const

export function isModelProvider(value: unknown): value is ModelProvider {
  return MODEL_PROVIDERS.some((provider) => provider === value)
}

export function isServerProvider(value: unknown): value is ServerProvider {
  return SERVER_PROVIDERS.some((provider) => provider === value)
}

export function isHostedProvider(value: unknown): value is HostedProvider {
  return HOSTED_PROVIDERS.some((provider) => provider === value)
}

type SharedModelFields = {
  id: string
  displayName: string
  contextLength?: number
  supportsImageInput: boolean
}

export type HostedModel = SharedModelFields & {
  provider: HostedProvider
  /** Fast serving-path ID when Fireworks publishes one for this model; Fireworks only. */
  fastId?: string
}

export type FireworksModel = HostedModel & { provider: "fireworks" }

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

export type ServerCatalogModel = SharedModelFields & {
  provider: ServerProvider
  baseURL: string
}

export type CatalogModel = HostedModel | LocalCatalogModel | PairCatalogModel | ServerCatalogModel

export function isHostedModel(model: CatalogModel): model is HostedModel {
  return isHostedProvider(model.provider)
}

export function isServerCatalogModel(model: CatalogModel): model is ServerCatalogModel {
  return isServerProvider(model.provider)
}

export function isLocalCatalogModel(model: CatalogModel): model is LocalCatalogModel {
  return model.provider === "local"
}

export function isPairCatalogModel(model: CatalogModel): model is PairCatalogModel {
  return model.provider === "pair"
}

export type InferenceClient = {
  readonly model: string
  /**
   * Counts the fully formatted request without running inference, when supported by the
   * serving endpoint.
   */
  countTokens?(options: StreamChatOptions): Promise<number>
  streamChat(options: StreamChatOptions): AsyncGenerator<ChatStreamEvent>
  complete(messages: ChatMessage[], options?: CompleteOptions): Promise<string>
}

/** Presentation formats the active adapter can render natively. */
export type OutputCapabilities = {
  mermaid?: boolean
  /** TeX math in Markdown documents opened in Canvas. */
  math?: boolean
}

export type StreamChatOptions = {
  messages: ChatMessage[]
  /** Replaces the working agent instructions for internal tasks such as compaction. */
  systemPrompt?: string
  tools?: ToolDefinition[]
  projectContext?: ContextFile[]
  signal?: AbortSignal
  now?: Date
  skills?: readonly import("../skills/catalog.js").Skill[]
  outputCapabilities?: OutputCapabilities
  /** Spend as little on reasoning as the model allows, e.g. for a summary that must fit. */
  minimalReasoning?: boolean
}

export type CompleteOptions = {
  projectContext?: ContextFile[]
  signal?: AbortSignal
  onUsage?: (usage: TokenUsage) => void | Promise<void>
}

export type HostedClientConfig = {
  provider: HostedProvider
  apiKey: string
  model: string
  /** Sent as `X-Prime-Team-ID`: Prime Intellect bills this team's wallet, not the key owner's. */
  teamId?: string
  fetch?: typeof fetch
  inferenceURL?: string
  /** Abandon a request whose response stays silent this long; every chunk restarts the clock. */
  idleTimeoutMs?: number
}

export type LocalClientConfig = {
  model: string
  inferenceURL: string
  fetch?: typeof fetch
  apiKey?: string
  idleTimeoutMs?: number
}

/**
 * The servers a platform can connect to: oMLX runs on macOS only; every platform can name its own
 * OpenAI-compatible one. Safe to import in UI adapters.
 */
export function serverProviders(platform: string | undefined): ServerProvider[] {
  return SERVER_PROVIDERS.filter((provider) => provider !== "omlx" || platform === "darwin")
}

/** One tab per local server a desktop form offers: the PAIR engines, then the platform's servers. */
export type LocalServerTab = "ollama" | "lmStudio" | ServerProvider
export function localServerTabs(platform: string | undefined): [LocalServerTab, string][] {
  return [
    ["ollama", "Ollama"],
    ["lmStudio", "LM Studio"],
    ...serverProviders(platform).map((p): [LocalServerTab, string] => [p, SERVER_INFO[p].name]),
  ]
}

/** A setup form's fields for the servers a platform offers: saved settings, else the default. */
export function serverFormInputs(
  platform: string | undefined,
  saved: Partial<
    Record<ServerProvider, { baseURL: string; model?: string; contextLength?: number }>
  >,
) {
  const inputs: Partial<
    Record<ServerProvider, { baseURL: string; model: string; contextLength: string }>
  > = {}
  for (const provider of serverProviders(platform)) {
    const server = saved[provider]
    inputs[provider] = {
      baseURL: server?.baseURL ?? SERVER_INFO[provider].defaultEndpoint,
      model: server?.model ?? "",
      contextLength: server?.contextLength?.toString() ?? "",
    }
  }
  return inputs
}

export function localServerNames(platform: string | undefined): string[] {
  return localServerTabs(platform).map(([tab, name]) =>
    tab === "custom" ? "any OpenAI-compatible server" : name,
  )
}

export const MAX_IMAGES_PER_REQUEST = 30
export const MAX_BASE64_IMAGE_BYTES = 10_000_000
export const MAX_RAW_IMAGE_BYTES = Math.floor(((MAX_BASE64_IMAGE_BYTES - 1) * 3) / 4)

export const SUPPORTED_IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".ppm",
] as const

export function base64EncodedLength(byteLength: number) {
  return 4 * Math.ceil(byteLength / 3)
}
