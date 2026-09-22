import { requireLocalContextLength } from "./context-policy.js"
import { validateDocumentAttachments } from "./documents.js"
import { ContextOverflowError, inferenceResponseError } from "./errors.js"
import { validateImageAttachments } from "./images.js"
import {
  formatDocumentForModel,
  imageAttachmentsFromMessages,
  textContent,
  userMessageDocuments,
} from "./messages.js"
import { parseChatCompletionStream } from "./stream-parser.js"
import { buildSystemPrompt } from "./system-prompt.js"
import type {
  ChatMessage,
  CompleteOptions,
  InferenceClient,
  StreamChatOptions,
  ToolDefinition,
} from "./types.js"

export function openaiChatCompletionRequest(
  model: string,
  options: StreamChatOptions,
  extras: { reasoningEffort?: string; serviceTier?: string } = {},
) {
  const tools = options.tools ?? []
  validateImageAttachments(imageAttachmentsFromMessages(options.messages))
  for (const message of options.messages) {
    if (message.role === "user") validateDocumentAttachments(userMessageDocuments(message))
  }
  return {
    model,
    ...(extras.serviceTier ? { service_tier: extras.serviceTier } : {}),
    messages: [
      {
        role: "system",
        content:
          options.systemPrompt ??
          buildSystemPrompt(
            options.projectContext,
            options.now,
            options.skills,
            tools,
            options.outputCapabilities,
          ),
      },
      ...toolCallHistoryForRequest(options.messages).map((message) => {
        if (message.role === "tool") {
          return { role: "tool", tool_call_id: message.toolCallId, content: message.content }
        }
        if (message.role === "user") {
          if (typeof message.content === "string") return { role: "user", content: message.content }
          return {
            role: "user",
            content: message.content.map((part) => {
              if (part.type === "image") {
                return {
                  type: "image_url",
                  image_url: { url: `data:${part.mimeType};base64,${part.data}` },
                }
              }
              return part.type === "document"
                ? { type: "text", text: formatDocumentForModel(part) }
                : part
            }),
          }
        }
        const reasoning = new Map<string, string>()
        const toolCalls = []
        for (const part of message.content) {
          if (part.type === "reasoning")
            reasoning.set(part.field, `${reasoning.get(part.field) ?? ""}${part.text}`)
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
          content: textContent(message.content) || null,
          ...Object.fromEntries(reasoning),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        }
      }),
    ],
    ...(tools.length > 0 ? { tools: tools.map(openaiTool) } : {}),
    ...(extras.reasoningEffort ? { reasoning_effort: extras.reasoningEffort } : {}),
    stream: true,
    stream_options: { include_usage: true },
  }
}

export function openaiTool(tool: ToolDefinition) {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }
}

/** Runs a tool-free turn and returns its trimmed text, forwarding usage so callers can meter it. */
export async function collectCompletionText(
  client: Pick<InferenceClient, "streamChat">,
  messages: ChatMessage[],
  options: CompleteOptions,
) {
  let text = ""
  for await (const event of client.streamChat({
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

export function inferenceEndpointURL(value: string, label: string) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} is invalid.`)
  }
  const localHTTP = parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)
  if (parsed.protocol !== "https:" && !localHTTP) throw new Error(`${label} must use HTTPS.`)
  return parsed.toString()
}

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

export function requiredText(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  return trimmed
}

/** Local servers, including PAIR proxies, share the same loopback ingress boundary. */
export function normalizeLocalBaseURL(value: string) {
  const input = value.trim()
  if (!input) throw new Error("Local model server endpoint is required.")
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error("Local model server endpoint is invalid.")
  }
  if (parsed.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) {
    throw new Error("Local model server endpoint must use HTTP on 127.0.0.1, localhost, or ::1.")
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "Local model server endpoint must not include credentials, query parameters, or a fragment.",
    )
  }
  const path = parsed.pathname.replace(/\/+$/, "")
  if (path && path !== "/v1") {
    throw new Error("Local model server endpoint must be a base URL without an API path.")
  }
  parsed.pathname = "/"
  return parsed.toString().replace(/\/$/, "")
}

const INVALID_TOOL_ARGUMENTS_RESULT =
  "This tool call failed because its arguments were not a complete JSON object. " +
  "The invalid arguments were omitted from this request. Generate a fresh call using smaller steps; " +
  "do not repeat earlier successful actions."

export function hasObjectArguments(argumentsJSON: string): boolean {
  try {
    const value: unknown = JSON.parse(argumentsJSON)
    return typeof value === "object" && value !== null && !Array.isArray(value)
  } catch {
    return false
  }
}

/**
 * A request-only projection: never mutate the transcript or guess missing tool input.
 * Keep call IDs and matching results, but replace malformed arguments with a valid
 * empty object and an explicit failure result. This also recovers older saved sessions.
 */
export function toolCallHistoryForRequest(messages: readonly ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  const invalid = new Set<string>()
  const missing = new Set<string>()
  const finishBatch = () => {
    for (const toolCallId of missing)
      result.push({ role: "tool", toolCallId, content: INVALID_TOOL_ARGUMENTS_RESULT })
    missing.clear()
    invalid.clear()
  }
  for (const message of messages) {
    if (message.role !== "tool") finishBatch()
    if (message.role === "assistant") {
      const content = message.content.map((part) => {
        if (part.type !== "tool_call" || hasObjectArguments(part.toolCall.arguments)) return part
        invalid.add(part.toolCall.id)
        missing.add(part.toolCall.id)
        return { ...part, toolCall: { ...part.toolCall, arguments: "{}" } }
      })
      result.push(invalid.size ? { ...message, content } : message)
    } else if (message.role === "tool" && invalid.has(message.toolCallId)) {
      missing.delete(message.toolCallId)
      result.push({ ...message, content: INVALID_TOOL_ARGUMENTS_RESULT })
    } else result.push(message)
  }
  finishBatch()
  return result
}

type OpenAICompatibleClientConfig = {
  model: string
  inferenceURL: string
  modelLabel: string
  inferenceURLLabel: string
  requestLabel: string
  fetch?: typeof fetch
  apiKey?: string
}

/** Shared transport for local OpenAI-compatible inference servers. */
export class OpenAICompatibleClient implements InferenceClient {
  readonly model: string
  readonly #fetch: typeof fetch
  readonly #inferenceURL: string
  readonly #apiKey: string | undefined
  readonly #requestLabel: string

  constructor(config: OpenAICompatibleClientConfig) {
    this.model = requiredText(config.model, config.modelLabel)
    this.#fetch = config.fetch ?? fetch
    this.#inferenceURL = inferenceEndpointURL(config.inferenceURL, config.inferenceURLLabel)
    this.#apiKey = config.apiKey?.trim() || undefined
    this.#requestLabel = config.requestLabel
  }

  async *streamChat(options: StreamChatOptions) {
    try {
      const response = await this.request(options)
      if (!response.body)
        throw new Error(`${this.#requestLabel} response did not include a stream body`)
      yield* parseChatCompletionStream(response.body)
    } catch (error) {
      if (error instanceof ContextOverflowError)
        requireLocalContextLength(error.contextLength, this.#requestLabel)
      if (this.#apiKey && error instanceof Error)
        error.message = error.message.replaceAll(this.#apiKey, "[redacted]")
      throw error
    }
  }

  protected async request(options: StreamChatOptions, suffix = "") {
    const url = new URL(this.#inferenceURL)
    url.pathname = `${url.pathname.replace(/\/$/, "")}${suffix}`
    const response = await this.#fetch(url.toString(), {
      method: "POST",
      headers: {
        accept: suffix ? "application/json" : "text/event-stream",
        "content-type": "application/json",
        ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
      },
      body: JSON.stringify(this.requestBody(options)),
      signal: options.signal,
      redirect: "error",
    })
    if (!response.ok) throw await inferenceResponseError(response, this.#requestLabel)
    return response
  }

  protected requestBody(options: StreamChatOptions) {
    return openaiChatCompletionRequest(this.model, options)
  }

  complete(messages: ChatMessage[], options: CompleteOptions = {}) {
    return collectCompletionText(this, messages, options)
  }
}
