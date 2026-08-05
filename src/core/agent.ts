import type { FireworksClient } from "../inference/client.js"
import type {
  AssistantContentPart,
  ChatMessage,
  ChatToolCall,
  ContextFile,
  OpenAICompatibleReasoningField,
  TokenUsage,
} from "../inference/types.js"
import { createPermissionPolicy, type PermissionPolicy, type PermissionRequest } from "../permissions/policy.js"
import {
  describeToolCall,
  executeToolCall,
  parseSerializedToolCall,
  TOOL_DEFINITIONS,
  type ToolActivityKind,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "../tools/index.js"
import { loadProjectContext } from "./context.js"

export type AgentEvent =
  | { type: "context"; messageCount: number; contentChars: number }
  | { type: "debug"; message: string }
  | { type: "model"; phase: "start" }
  | { type: "reasoning" }
  | { type: "delta"; text: string }
  | {
      type: "tool"
      phase: "start" | "end"
      toolCallId: string
      name: ToolCall["name"]
      activityKind: ToolActivityKind
      label: string
      diff?: string
      outcome?: "completed" | "denied" | "failed"
    }
  | { type: "interrupted"; messages: ChatMessage[] }
  | { type: "complete"; messages: ChatMessage[] }
  | { type: "error"; message: string; messages?: ChatMessage[] }

export type RunAgentOptions = ToolContext & {
  client: FireworksClient
  debug?: boolean
  onUsage?: (usage: TokenUsage) => void | Promise<void>
  permissionPolicy?: PermissionPolicy
  onPermissionRequest?: (request: PermissionRequest) => Promise<boolean>
  projectContext?: ContextFile[]
  tools?: ToolDefinition[]
  maxSteps?: number
}

export async function* runAgent(
  input: string,
  history: ChatMessage[] = [],
  options: RunAgentOptions,
): AsyncGenerator<AgentEvent> {
  const messages: ChatMessage[] = [...history, { role: "user", content: input }]
  try {
    const projectContext = options.projectContext ?? loadProjectContext(options.cwd ?? process.cwd())
    const toolContext: RunAgentOptions = {
      ...options,
      permissionPolicy:
        options.permissionPolicy ?? createPermissionPolicy({ cwd: options.cwd ?? process.cwd(), mode: "ask" }),
      webSession: {},
    }
    yield { type: "context", messageCount: messages.length, contentChars: messagesContentChars(messages) }

    let step = 0
    while (true) {
      if (options.maxSteps !== undefined && step >= options.maxSteps) {
        yield {
          type: "error",
          message: `Agent reached the ${options.maxSteps}-step limit.`,
          messages: turnMessages(messages, history.length),
        }
        return
      }
      step += 1
      yield { type: "model", phase: "start" }
      const response = yield* streamAssistantResponse(messages, options.tools ?? TOOL_DEFINITIONS, {
        ...options,
        projectContext,
      })
      const assistantMessage = assistantMessageFromResponse(response)
      if (assistantMessage.content.length > 0) messages.push(assistantMessage)

      if (response.interrupted) {
        if (response.toolCalls.length > 0) {
          messages.push(...interruptedToolCalls([], response.toolCalls).messages)
        }
        yield { type: "interrupted", messages: turnMessages(messages, history.length) }
        return
      }

      yield { type: "context", messageCount: messages.length, contentChars: messagesContentChars(messages) }

      if (response.toolCalls.length === 0) {
        if (!hasText(response)) {
          yield {
            type: "error",
            message: "The model returned an empty response.",
            messages: turnMessages(messages, history.length),
          }
          return
        }
        yield { type: "complete", messages: turnMessages(messages, history.length) }
        return
      }

      const execution = yield* executeToolCalls(response.toolCalls, toolContext)
      messages.push(...execution.messages)
      if (execution.interrupted) {
        yield { type: "interrupted", messages: turnMessages(messages, history.length) }
        return
      }
      yield { type: "context", messageCount: messages.length, contentChars: messagesContentChars(messages) }
    }
  } catch (error) {
    if (options.signal?.aborted) {
      yield { type: "interrupted", messages: turnMessages(messages, history.length) }
      return
    }
    yield {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      messages: turnMessages(messages, history.length),
    }
  }
}

type AssistantResponse = {
  text: string
  reasoning: Array<{ text: string; field: OpenAICompatibleReasoningField }>
  toolCalls: ChatToolCall[]
  interrupted: boolean
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

  try {
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
        yield { type: "reasoning" }
      }
      if (event.type === "tool_call") toolCalls.push(event.toolCall)
      if (event.type === "usage") await options.onUsage?.(event.usage)
    }
  } catch (error) {
    if (!options.signal?.aborted) throw error
  }

  return {
    text,
    reasoning: [...reasoning].map(([field, text]) => ({ field, text })).filter((part) => part.text.length > 0),
    toolCalls,
    interrupted: options.signal?.aborted ?? false,
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
): AsyncGenerator<AgentEvent, { messages: ChatMessage[]; interrupted: boolean }> {
  const messages: ChatMessage[] = []

  for (const [index, rawCall] of calls.entries()) {
    if (context.signal?.aborted) return interruptedToolCalls(messages, calls.slice(index))

    const call = parseToolCall(rawCall)

    if (!call.ok) {
      if (context.debug) yield { type: "debug", message: `Invalid ${rawCall.name} tool call: ${call.message}` }
      messages.push({ role: "tool", toolCallId: rawCall.id, content: `Invalid tool call: ${call.message}` })
      continue
    }

    if (!(context.tools ?? TOOL_DEFINITIONS).some((tool) => tool.name === call.value.name)) {
      const message = `Tool is not enabled: ${call.value.name}`
      if (context.debug) yield { type: "debug", message }
      messages.push({ role: "tool", toolCallId: rawCall.id, content: message })
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
    let outcome: "completed" | "denied" | "failed" = "completed"
    try {
      if (context.signal?.aborted) return interruptedToolCalls(messages, calls.slice(index))

      const permission = await context.permissionPolicy?.evaluate(call.value)
      if (permission?.effect === "deny") {
        outcome = "denied"
        messages.push({ role: "tool", toolCallId: rawCall.id, content: "Permission denied by policy." })
        continue
      }
      if (permission?.effect === "ask") {
        if (!context.onPermissionRequest) {
          outcome = "denied"
          messages.push({
            role: "tool",
            toolCallId: rawCall.id,
            content: "Permission approval required, but no approval handler is available.",
          })
          continue
        }
        const approved = await context.onPermissionRequest({ call: call.value, decision: permission })
        if (context.signal?.aborted) return interruptedToolCalls(messages, calls.slice(index))
        if (!approved) {
          outcome = "denied"
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
      outcome = "failed"
      if (context.signal?.aborted) return interruptedToolCalls(messages, calls.slice(index))
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
        outcome,
      }
    }
  }

  return { messages, interrupted: false }
}

function interruptedToolCalls(messages: ChatMessage[], calls: ChatToolCall[]) {
  messages.push(
    ...calls.map(
      (call): ChatMessage => ({
        role: "tool",
        toolCallId: call.id,
        content: "Tool call interrupted by user.",
      }),
    ),
  )
  return { messages, interrupted: true }
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
