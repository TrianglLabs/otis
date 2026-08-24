import type { Skill } from "../skills/index.js"
import { validateImageAttachments } from "./images.js"
import { imageAttachmentsFromMessages } from "./messages.js"
import { highestReasoningEffort } from "./reasoning.js"
import { fireworksServiceTier } from "./serving-path.js"
import { parseChatCompletionStream } from "./stream-parser.js"
import { buildSystemPrompt } from "./system-prompt.js"
import type { ChatMessage, ChatStreamEvent, ContextFile, FireworksClientConfig, ToolDefinition } from "./types.js"

export { listToolCapableModels } from "./catalog.js"

const DEFAULT_INFERENCE_URL = "https://api.fireworks.ai/inference/v1/chat/completions"

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

type StreamChatOptions = {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  projectContext?: ContextFile[]
  signal?: AbortSignal
  now?: Date
  skills?: readonly Skill[]
}

type CompleteOptions = {
  projectContext?: ContextFile[]
  signal?: AbortSignal
  onUsage?: (usage: import("./types.js").TokenUsage) => void | Promise<void>
}

function chatRequest(model: string, options: StreamChatOptions) {
  const tools = options.tools ?? []
  validateImageAttachments(imageAttachmentsFromMessages(options.messages))
  const reasoningEffort = highestReasoningEffort(model)
  const serviceTier = fireworksServiceTier(model)
  return {
    model,
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    messages: [
      { role: "system", content: buildSystemPrompt(options.projectContext, options.now, options.skills) },
      ...options.messages.map(providerMessage),
    ],
    ...(tools.length > 0 ? { tools: tools.map(providerTool) } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    stream: true,
    stream_options: { include_usage: true },
  }
}

function providerMessage(message: ChatMessage) {
  if (message.role === "user") {
    return {
      role: "user",
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) =>
              part.type === "text"
                ? part
                : {
                    type: "image_url",
                    image_url: { url: `data:${part.mimeType};base64,${part.data}` },
                  },
            ),
    }
  }
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
