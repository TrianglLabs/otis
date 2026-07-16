import { highestReasoningEffort } from "./reasoning.js"
import { parseChatCompletionStream } from "./stream-parser.js"
import { buildSystemPrompt } from "./system-prompt.js"
import type {
  ChatMessage,
  ChatStreamEvent,
  ContextFile,
  FireworksClientConfig,
  FireworksModel,
  ToolDefinition,
} from "./types.js"

const DEFAULT_INFERENCE_URL = "https://api.fireworks.ai/inference/v1/chat/completions"
const DEFAULT_MODELS_URL = "https://api.fireworks.ai/v1/accounts/fireworks/models"
const TOOL_CAPABLE_SERVERLESS_FILTER = "supports_serverless=true AND supports_tools=true"
const MAX_MODEL_PAGES = 20

export class FireworksClient {
  readonly model: string
  readonly #apiKey: string
  readonly #fetch: typeof fetch
  readonly #inferenceURL: string

  constructor(config: FireworksClientConfig) {
    this.#apiKey = required(config.apiKey, "Fireworks API key")
    this.model = required(config.model, "Fireworks model")
    this.#fetch = config.fetch ?? fetch
    this.#inferenceURL = validHttpsURL(config.inferenceURL ?? DEFAULT_INFERENCE_URL, "Fireworks inference URL")
  }

  async *streamChat(options: StreamChatOptions): AsyncGenerator<ChatStreamEvent> {
    const response = await this.#fetch(this.#inferenceURL, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(chatRequest(this.model, options)),
      signal: options.signal,
    })

    if (!response.ok) {
      throw new Error(`Fireworks request failed with HTTP ${response.status}: ${await responseText(response)}`)
    }
    if (!response.body) throw new Error("Fireworks response did not include a stream body")
    yield* parseChatCompletionStream(response.body)
  }

  async complete(messages: ChatMessage[], options: CompleteOptions = {}) {
    let text = ""
    for await (const event of this.streamChat({
      messages,
      projectContext: options.projectContext,
      signal: options.signal,
      tools: [],
    })) {
      if (event.type === "text_delta") text += event.text
      if (event.type === "usage") await options.onUsage?.(event.usage)
    }
    return text.trim()
  }
}

export async function listToolCapableModels(apiKey: string, options: ListModelsOptions = {}) {
  const key = required(apiKey, "Fireworks API key")
  const fetchImpl = options.fetch ?? fetch
  const endpoint = validHttpsURL(options.modelsURL ?? DEFAULT_MODELS_URL, "Fireworks models URL")
  const models: FireworksModel[] = []
  const seenNames = new Set<string>()
  const seenPageTokens = new Set<string>()
  let pageToken: string | undefined

  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const url = new URL(endpoint)
    url.searchParams.set("pageSize", "200")
    url.searchParams.set("filter", TOOL_CAPABLE_SERVERLESS_FILTER)
    if (pageToken) url.searchParams.set("pageToken", pageToken)

    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${key}` }, signal: options.signal })
    if (!response.ok) {
      throw new Error(`Could not load Fireworks models (HTTP ${response.status}): ${await responseText(response)}`)
    }

    const result = parseModelsResponse(await response.json())
    for (const model of result.models) {
      if (!model.supportsServerless || !model.supportsTools || seenNames.has(model.name)) continue
      seenNames.add(model.name)
      models.push({
        id: model.name,
        displayName: model.displayName || model.name.split("/").at(-1) || model.name,
        ...(model.contextLength === undefined ? {} : { contextLength: model.contextLength }),
      })
    }

    pageToken = result.nextPageToken
    if (!pageToken) break
    if (seenPageTokens.has(pageToken)) throw new Error("Fireworks model pagination returned a repeated page token.")
    seenPageTokens.add(pageToken)
  }

  if (pageToken) throw new Error(`Fireworks model catalog exceeded ${MAX_MODEL_PAGES} pages.`)

  return models.sort(
    (left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
  )
}

type StreamChatOptions = {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  projectContext?: ContextFile[]
  signal?: AbortSignal
  now?: Date
}

type CompleteOptions = {
  projectContext?: ContextFile[]
  signal?: AbortSignal
  onUsage?: (usage: import("./types.js").TokenUsage) => void | Promise<void>
}

type ListModelsOptions = {
  fetch?: typeof fetch
  modelsURL?: string
  signal?: AbortSignal
}

function chatRequest(model: string, options: StreamChatOptions) {
  const tools = options.tools ?? []
  const reasoningEffort = highestReasoningEffort(model)
  return {
    model,
    messages: [
      { role: "system", content: buildSystemPrompt(options.projectContext, options.now) },
      ...options.messages.map(providerMessage),
    ],
    ...(tools.length > 0 ? { tools: tools.map(providerTool) } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    stream: true,
    stream_options: { include_usage: true },
  }
}

function providerMessage(message: ChatMessage) {
  if (message.role === "user") return { role: "user", content: message.content }
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content }

  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
  const reasoning = new Map<string, string>()
  const toolCalls = []

  for (const part of message.content) {
    if (part.type === "reasoning") reasoning.set(part.field, `${reasoning.get(part.field) ?? ""}${part.text}`)
    if (part.type === "tool_call") {
      toolCalls.push({
        id: part.toolCall.id,
        type: "function",
        function: { name: part.toolCall.name, arguments: part.toolCall.arguments || "{}" },
      })
    }
  }

  return {
    role: "assistant",
    content: text || null,
    ...Object.fromEntries(reasoning),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

function providerTool(tool: ToolDefinition) {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }
}

function parseModelsResponse(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.models)) throw new Error("Fireworks models response was invalid.")
  return {
    models: value.models.map(parseModel).filter((model): model is RawModel => model !== undefined),
    nextPageToken: nonEmptyString(value.nextPageToken),
  }
}

type RawModel = {
  name: string
  displayName?: string
  contextLength?: number
  supportsServerless: boolean
  supportsTools: boolean
}

function parseModel(value: unknown): RawModel | undefined {
  if (!isRecord(value)) return undefined
  const name = nonEmptyString(value.name)
  if (!name) return undefined
  return {
    name,
    displayName: nonEmptyString(value.displayName),
    contextLength: positiveInteger(value.contextLength),
    supportsServerless: value.supportsServerless === true,
    supportsTools: value.supportsTools === true,
  }
}

function validHttpsURL(value: string, label: string) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} is invalid.`)
  }
  const localHTTP = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  if (parsed.protocol !== "https:" && !localHTTP) throw new Error(`${label} must use HTTPS.`)
  return parsed.toString()
}

function required(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  return trimmed
}

async function responseText(response: Response) {
  try {
    return (await response.text()).slice(0, 2000) || response.statusText
  } catch {
    return response.statusText
  }
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
