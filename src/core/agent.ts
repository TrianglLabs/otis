import type { FireworksClient } from "../inference/client.js"
import type {
  AssistantContentPart,
  ChatMessage,
  ChatToolCall,
  ContextFile,
  OpenAICompatibleReasoningField,
  TokenUsage,
} from "../inference/types.js"
import {
  describeToolCall,
  executeToolCall,
  parseSerializedToolCall,
  TOOL_DEFINITIONS,
  type ToolActivityKind,
  type ToolCall,
  type ToolContext,
  type ToolResult,
} from "../tools/index.js"
import { loadProjectContext } from "./context.js"

export type AgentEvent =
  | { type: "context"; messageCount: number; contentChars: number }
  | { type: "debug"; message: string }
  | { type: "model"; phase: "start" }
  | { type: "delta"; text: string }
  | {
      type: "tool"
      phase: "start" | "end"
      toolCallId: string
      name: ToolCall["name"]
      activityKind: ToolActivityKind
      label: string
      diff?: string
    }
  | { type: "complete"; messages: ChatMessage[] }
  | { type: "error"; message: string }

export type RunAgentOptions = ToolContext & {
  client: FireworksClient
  debug?: boolean
  onUsage?: (usage: TokenUsage) => void | Promise<void>
  onPermissionRequest?: (call: ToolCall) => Promise<boolean>
  projectContext?: ContextFile[]
}

export async function* runAgent(
  input: string,
  history: ChatMessage[] = [],
  options: RunAgentOptions,
): AsyncGenerator<AgentEvent> {
  try {
    const projectContext = options.projectContext ?? loadProjectContext(options.cwd ?? process.cwd())
    const messages: ChatMessage[] = [...history, { role: "user", content: input }]
    const toolContext: RunAgentOptions = { ...options, webSession: {} }
    yield { type: "context", messageCount: messages.length, contentChars: messagesContentChars(messages) }

    while (true) {
      yield { type: "model", phase: "start" }
      const response = yield* streamAssistantResponse(messages, TOOL_DEFINITIONS, {
        ...options,
        projectContext,
      })
      const assistantMessage = assistantMessageFromResponse(response)
      messages.push(assistantMessage)
      yield { type: "context", messageCount: messages.length, contentChars: messagesContentChars(messages) }

      if (response.toolCalls.length === 0) {
        if (!hasText(response)) {
          yield { type: "error", message: "The model returned an empty response." }
          return
        }
        yield { type: "complete", messages: turnMessages(messages, history.length) }
        return
      }

      messages.push(...(yield* executeToolCalls(response.toolCalls, toolContext)))
      yield { type: "context", messageCount: messages.length, contentChars: messagesContentChars(messages) }
    }
  } catch (error) {
    if (options.signal?.aborted) return
    yield { type: "error", message: error instanceof Error ? error.message : String(error) }
  }
}

type AssistantResponse = {
  text: string
  reasoning: Array<{ text: string; field: OpenAICompatibleReasoningField }>
  toolCalls: ChatToolCall[]
}

async function* streamAssistantResponse(
  messages: ChatMessage[],
  tools = TOOL_DEFINITIONS,
  options: Pick<RunAgentOptions, "client" | "signal" | "projectContext" | "onUsage">,
): AsyncGenerator<AgentEvent, AssistantResponse> {
  let text = ""
  const reasoning = new Map<OpenAICompatibleReasoningField, string>()
  const toolCalls: ChatToolCall[] = []
  const projectContext = options.projectContext ?? []

  for await (const event of options.client.streamChat({
    messages,
    tools,
    projectContext: projectContext.length > 0 ? projectContext : undefined,
    signal: options.signal,
  })) {
    if (event.type === "text_delta") {
      text += event.text
      yield { type: "delta", text: event.text }
    }
    if (event.type === "reasoning_delta") {
      reasoning.set(event.field, `${reasoning.get(event.field) ?? ""}${event.text}`)
    }
    if (event.type === "tool_call") toolCalls.push(event.toolCall)
    if (event.type === "usage") await options.onUsage?.(event.usage)
  }

  return {
    text,
    reasoning: [...reasoning].map(([field, text]) => ({ field, text })).filter((part) => part.text.length > 0),
    toolCalls,
  }
}

function assistantMessageFromResponse(response: AssistantResponse): ChatMessage {
  const content: AssistantContentPart[] = []

  content.push(...response.reasoning.map((part) => ({ type: "reasoning" as const, ...part })))
  if (response.text) content.push({ type: "text", text: response.text })
  content.push(...response.toolCalls.map((toolCall) => ({ type: "tool_call" as const, toolCall })))

  return {
    role: "assistant",
    content,
  }
}

function turnMessages(messages: ChatMessage[], historyLength: number) {
  return messages.slice(historyLength)
}

async function* executeToolCalls(
  calls: ChatToolCall[],
  context: RunAgentOptions,
): AsyncGenerator<AgentEvent, ChatMessage[]> {
  const messages: ChatMessage[] = []

  for (const rawCall of calls) {
    if (context.signal?.aborted) return messages

    const call = parseToolCall(rawCall)

    if (!call.ok) {
      if (context.debug) yield { type: "debug", message: `Invalid ${rawCall.name} tool call: ${call.message}` }
      messages.push({ role: "tool", toolCallId: rawCall.id, content: `Invalid tool call: ${call.message}` })
      continue
    }

    const activity = describeToolCall(call.value)

    yield {
      type: "tool",
      phase: "start",
      toolCallId: rawCall.id,
      name: call.value.name,
      activityKind: activity.kind,
      label: activity.label,
    }

    let result: ToolResult | undefined
    try {
      if (context.signal?.aborted) return messages

      if (isDestructiveTool(call.value.name) && context.onPermissionRequest) {
        const approved = await context.onPermissionRequest(call.value)
        if (context.signal?.aborted) return messages
        if (!approved) {
          messages.push({ role: "tool", toolCallId: rawCall.id, content: "Permission denied by user." })
          continue
        }
      }

      result = await executeToolCall(call.value, context)
      messages.push({
        role: "tool",
        toolCallId: rawCall.id,
        content: formatToolResult(call.value.name, result),
      })
    } catch (error) {
      if (context.signal?.aborted) return messages
      const message = error instanceof Error ? error.message : String(error)
      if (context.debug) yield { type: "debug", message: `Tool ${call.value.name} failed: ${message}` }
      messages.push({ role: "tool", toolCallId: rawCall.id, content: `Error: ${message}` })
    } finally {
      yield {
        type: "tool",
        phase: "end",
        toolCallId: rawCall.id,
        name: call.value.name,
        activityKind: activity.kind,
        label: activity.label,
        diff: result?.diff,
      }
    }
  }

  return messages
}

function parseToolCall(rawCall: ChatToolCall): { ok: true; value: ToolCall } | { ok: false; message: string } {
  try {
    return { ok: true, value: parseSerializedToolCall(rawCall.name, rawCall.arguments) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function formatToolResult(name: ToolCall["name"], result: ToolResult) {
  return `${name}: ${result.title}\n\n${truncate(result.output)}`
}

function truncate(text: string, maxLength = 16_000) {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n\n[Tool output truncated to ${maxLength} characters.]`
}

function hasText(response: AssistantResponse) {
  return response.text.trim().length > 0
}

function messagesContentChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + messageContentChars(message), 0)
}

function messageContentChars(message: ChatMessage): number {
  let chars = message.role.length
  if (message.role === "user") return chars + message.content.length
  if (message.role === "tool") return chars + message.toolCallId.length + message.content.length
  for (const part of message.content) {
    if (part.type === "text") chars += part.text.length
    else if (part.type === "reasoning") chars += part.text.length
    else chars += part.toolCall.id.length + part.toolCall.name.length + part.toolCall.arguments.length
  }
  return chars
}

const DESTRUCTIVE_TOOLS = new Set<ToolCall["name"]>(["bash", "write", "edit"])

function isDestructiveTool(name: ToolCall["name"]): boolean {
  return DESTRUCTIVE_TOOLS.has(name)
}
