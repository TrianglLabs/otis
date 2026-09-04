import { validateImageAttachments } from "./images.js"
import { imageAttachmentsFromMessages } from "./messages.js"
import { buildSystemPrompt } from "./system-prompt.js"
import type { ChatMessage, StreamChatOptions, ToolDefinition } from "./types.js"

export function openaiChatCompletionRequest(
  model: string,
  options: StreamChatOptions,
  extras: { reasoningEffort?: string; serviceTier?: string } = {},
) {
  const tools = options.tools ?? []
  validateImageAttachments(imageAttachmentsFromMessages(options.messages))
  return {
    model,
    ...(extras.serviceTier ? { service_tier: extras.serviceTier } : {}),
    messages: [
      { role: "system", content: buildSystemPrompt(options.projectContext, options.now, options.skills) },
      ...options.messages.map(openaiMessage),
    ],
    ...(tools.length > 0 ? { tools: tools.map(openaiTool) } : {}),
    ...(extras.reasoningEffort ? { reasoning_effort: extras.reasoningEffort } : {}),
    stream: true,
    stream_options: { include_usage: true },
  }
}

export function openaiMessage(message: ChatMessage) {
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

export function openaiTool(tool: ToolDefinition) {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }
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

export function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

export function requiredText(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  return trimmed
}

export async function responsePreview(response: Response) {
  try {
    return (await response.text()).slice(0, 2000) || response.statusText
  } catch {
    return response.statusText
  }
}
