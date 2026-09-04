import { userMessageContentChars } from "../inference/messages.js"
import type {
  ChatMessage,
  ChatToolCall,
  ContextFile,
  InferenceClient,
  ReasoningTraceEvent,
  TokenUsage,
  UserChatMessage,
} from "../inference/types.js"
import {
  createPermissionPolicy,
  DEFAULT_PERMISSION_MODE,
  type PermissionPolicy,
  type PermissionRequest,
} from "../permissions/policy.js"
import { loadSkillCatalog, type SkillCatalog } from "../skills/index.js"
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
import { AssistantResponseBuilder } from "./assistant-response.js"
import { mergeGenerators, serialized } from "./concurrency.js"
import { loadProjectContext } from "./context.js"
import type { SteeringSource } from "./steering.js"
import { type SubagentCall, subagentBrief, subagentResult, subagentRunOptions } from "./subagent.js"

export type AgentEvent =
  | { type: "context"; messageCount: number; contentChars: number }
  | { type: "debug"; message: string }
  | { type: "model"; phase: "start" }
  | ReasoningTraceEvent
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
  /** An event from a delegated child run, identified by the parent's `agent` tool call. */
  | { type: "subagent"; toolCallId: string; title: string; event: AgentEvent }
  | { type: "interrupted"; messages: ChatMessage[] }
  | { type: "complete"; messages: ChatMessage[] }
  | { type: "error"; message: string; messages?: ChatMessage[] }

export type RunAgentOptions = ToolContext & {
  client: InferenceClient
  debug?: boolean
  onUsage?: (usage: TokenUsage) => void | Promise<void>
  permissionPolicy?: PermissionPolicy
  onPermissionRequest?: (request: PermissionRequest) => Promise<boolean>
  projectContext?: ContextFile[]
  skills?: SkillCatalog
  tools?: ToolDefinition[]
  maxSteps?: number
  steering?: SteeringSource
}

export async function* runAgent(
  input: string | UserChatMessage,
  history: ChatMessage[] = [],
  options: RunAgentOptions,
): AsyncGenerator<AgentEvent> {
  const userMessage: UserChatMessage = typeof input === "string" ? { role: "user", content: input } : input
  const messages: ChatMessage[] = [...history, userMessage]
  try {
    const projectContext = options.projectContext ?? loadProjectContext(options.cwd ?? process.cwd())
    const skills = options.skills ?? (await loadSkillCatalog(options.cwd ?? process.cwd()))
    const tools = availableTools(options.tools ?? TOOL_DEFINITIONS, skills)
    const modelSkills = tools.some((tool) => tool.name === "skill") ? skills : emptySkills()
    const toolContext: RunAgentOptions = {
      ...options,
      projectContext,
      skills,
      tools,
      permissionPolicy:
        options.permissionPolicy ??
        createPermissionPolicy({ cwd: options.cwd ?? process.cwd(), mode: DEFAULT_PERMISSION_MODE }),
      webSession: { id: options.webSession?.id },
    }
    yield { type: "context", messageCount: messages.length, contentChars: messagesContentChars(messages) }

    let step = 0
    while (true) {
      const steeringMessages = await options.steering?.drain()
      if (steeringMessages?.length) {
        messages.push(...steeringMessages)
        yield { type: "context", messageCount: messages.length, contentChars: messagesContentChars(messages) }
      }
      if (options.maxSteps !== undefined && step >= options.maxSteps) {
        messages.push(...(await closeSteering(options.steering)))
        yield {
          type: "error",
          message: `Agent reached the ${options.maxSteps}-step limit.`,
          messages: turnMessages(messages, history.length),
        }
        return
      }
      step += 1
      yield { type: "model", phase: "start" }
      const response = yield* streamAssistantResponse(messages, tools, {
        ...options,
        projectContext,
        skills: modelSkills,
      })
      const assistantMessage = assistantMessageFromResponse(response)
      if (assistantMessage.content.length > 0) messages.push(assistantMessage)

      if (response.interrupted) {
        if (response.toolCalls.length > 0) {
          messages.push(...interruptedToolCalls([], response.toolCalls).messages)
        }
        messages.push(...(await closeSteering(options.steering)))
        yield { type: "interrupted", messages: turnMessages(messages, history.length) }
        return
      }

      yield { type: "context", messageCount: messages.length, contentChars: messagesContentChars(messages) }

      if (response.toolCalls.length === 0) {
        const steeringMessages = await options.steering?.drainOrClose()
        if (steeringMessages?.length) {
          messages.push(...steeringMessages)
          yield { type: "context", messageCount: messages.length, contentChars: messagesContentChars(messages) }
          continue
        }
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
        messages.push(...(await closeSteering(options.steering)))
        yield { type: "interrupted", messages: turnMessages(messages, history.length) }
        return
      }
      yield { type: "context", messageCount: messages.length, contentChars: messagesContentChars(messages) }
    }
  } catch (error) {
    messages.push(...(await closeSteering(options.steering)))
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

async function closeSteering(steering: SteeringSource | undefined) {
  if (!steering) return []
  try {
    return await steering.close()
  } catch {
    return []
  }
}

type AssistantResponse = {
  content: Extract<ChatMessage, { role: "assistant" }>["content"]
  toolCalls: ChatToolCall[]
  hasText: boolean
  interrupted: boolean
}

async function* streamAssistantResponse(
  messages: ChatMessage[],
  tools = TOOL_DEFINITIONS,
  options: Pick<RunAgentOptions, "client" | "signal" | "projectContext" | "skills" | "onUsage">,
): AsyncGenerator<AgentEvent, AssistantResponse> {
  const response = new AssistantResponseBuilder()
  const projectContext = options.projectContext ?? []

  try {
    for await (const event of options.client.streamChat({
      messages,
      tools,
      projectContext: projectContext.length > 0 ? projectContext : undefined,
      skills: options.skills?.skills,
      signal: options.signal,
    })) {
      if (event.type === "text_delta") {
        yield* response.appendText(event.text)
        yield { type: "delta", text: event.text }
      }
      if (event.type === "reasoning_delta") {
        yield* response.appendReasoning(event.text, event.field)
      }
      if (event.type === "tool_call") yield* response.appendToolCall(event.toolCall)
      if (event.type === "usage") await options.onUsage?.(event.usage)
    }
  } catch (error) {
    if (!options.signal?.aborted) throw error
  }

  yield* response.finish()

  return {
    content: response.content,
    toolCalls: response.toolCalls,
    hasText: response.hasText(),
    interrupted: options.signal?.aborted ?? false,
  }
}

function availableTools(tools: ToolDefinition[], skills: SkillCatalog) {
  return skills.skills.length > 0 ? tools : tools.filter((tool) => tool.name !== "skill")
}

function emptySkills(): SkillCatalog {
  return { skills: [], byName: new Map() }
}

function assistantMessageFromResponse(response: AssistantResponse): ChatMessage {
  return {
    role: "assistant",
    content: response.content,
  }
}

function turnMessages(messages: ChatMessage[], historyLength: number) {
  return messages.slice(historyLength)
}

type ToolCallOutcome = { message: ChatMessage; interrupted: boolean }

/**
 * Executes a response's tool calls in order. Adjacent `agent` calls run concurrently because each delegates
 * read-only work to an isolated child; every other call runs one at a time so workspace mutations stay ordered.
 */
async function* executeToolCalls(
  calls: ChatToolCall[],
  context: RunAgentOptions,
): AsyncGenerator<AgentEvent, { messages: ChatMessage[]; interrupted: boolean }> {
  const messages: ChatMessage[] = []
  // The approval surface handles one request at a time, so concurrent children must take turns asking.
  const concurrentContext: RunAgentOptions = {
    ...context,
    onPermissionRequest: context.onPermissionRequest && serialized(context.onPermissionRequest),
  }

  let index = 0
  while (index < calls.length) {
    if (context.signal?.aborted) return interruptedToolCalls(messages, calls.slice(index))
    const batch = delegationBatch(calls, index)
    const outcomes =
      batch.length > 1
        ? yield* mergeGenerators(batch.map((call) => executeSingleToolCall(call, concurrentContext)))
        : [yield* executeSingleToolCall(calls[index], context)]
    messages.push(...outcomes.map((outcome) => outcome.message))
    index += outcomes.length
    if (outcomes.some((outcome) => outcome.interrupted)) return interruptedToolCalls(messages, calls.slice(index))
  }

  return { messages, interrupted: false }
}

/** Returns the run of consecutive `agent` calls starting at `index`, or just the call at `index`. */
function delegationBatch(calls: ChatToolCall[], index: number) {
  if (calls[index].name !== "agent") return [calls[index]]
  let end = index
  while (end < calls.length && calls[end].name === "agent") end += 1
  return calls.slice(index, end)
}

async function* executeSingleToolCall(
  rawCall: ChatToolCall,
  context: RunAgentOptions,
): AsyncGenerator<AgentEvent, ToolCallOutcome> {
  const toolMessage = (content: string): ToolCallOutcome => ({
    message: { role: "tool", toolCallId: rawCall.id, content },
    interrupted: false,
  })
  const interrupted = () => ({ message: interruptedToolMessage(rawCall), interrupted: true })

  const call = parseToolCall(rawCall)
  if (!call.ok) {
    if (context.debug) yield { type: "debug", message: `Invalid ${rawCall.name} tool call: ${call.message}` }
    return toolMessage(`Invalid tool call: ${call.message}`)
  }
  if (!(context.tools ?? TOOL_DEFINITIONS).some((tool) => tool.name === call.value.name)) {
    const message = `Tool is not enabled: ${call.value.name}`
    if (context.debug) yield { type: "debug", message }
    return toolMessage(message)
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
    if (context.signal?.aborted) return interrupted()

    const permission = await context.permissionPolicy?.evaluate(call.value)
    if (permission?.effect === "deny") {
      outcome = "denied"
      const matchedRule = permission.rule ? `: ${permission.rule.tool}(${permission.rule.resource ?? "*"})` : ""
      return toolMessage(`Permission denied by policy${matchedRule}.`)
    }
    if (permission?.effect === "ask") {
      if (!context.onPermissionRequest) {
        outcome = "denied"
        return toolMessage("Permission approval required, but no approval handler is available.")
      }
      const approved = await context.onPermissionRequest({ call: call.value, decision: permission })
      if (context.signal?.aborted) return interrupted()
      if (!approved) {
        outcome = "denied"
        return toolMessage("Permission denied by user.")
      }
    }

    result =
      call.value.name === "agent"
        ? yield* executeSubagent(call.value, rawCall.id, context)
        : await executeToolCall(call.value, context)
    return toolMessage(formatToolResult(call.value.name, result))
  } catch (error) {
    outcome = "failed"
    if (context.signal?.aborted) return interrupted()
    const message = error instanceof Error ? error.message : String(error)
    if (context.debug) yield { type: "debug", message: `Tool ${call.value.name} failed: ${message}` }
    return toolMessage(`Error: ${message}`)
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

/**
 * Runs a delegated agent loop to completion. Every child event surfaces wrapped in a `subagent` envelope so the
 * caller can render the full trace; the parent's own conversation only receives the child's final report.
 */
async function* executeSubagent(
  call: SubagentCall,
  toolCallId: string,
  context: RunAgentOptions,
): AsyncGenerator<AgentEvent, ToolResult> {
  const title = call.input.description
  for await (const event of runAgent(subagentBrief(call), [], subagentRunOptions(context))) {
    yield { type: "subagent", toolCallId, title, event }
    if (event.type === "complete") return subagentResult(call, event.messages)
    if (event.type === "interrupted") throw new Error("Subagent interrupted.")
    if (event.type === "error") throw new Error(`Subagent failed: ${event.message}`)
  }
  throw new Error("Subagent ended without a result.")
}

function interruptedToolCalls(messages: ChatMessage[], calls: ChatToolCall[]) {
  messages.push(...calls.map(interruptedToolMessage))
  return { messages, interrupted: true }
}

function interruptedToolMessage(call: ChatToolCall): ChatMessage {
  return { role: "tool", toolCallId: call.id, content: "Tool call interrupted by user." }
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
  return response.hasText
}

function messagesContentChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + messageContentChars(message), 0)
}

function messageContentChars(message: ChatMessage): number {
  let chars = message.role.length
  if (message.role === "user") return chars + userMessageContentChars(message)
  if (message.role === "tool") return chars + message.toolCallId.length + message.content.length
  for (const part of message.content) {
    if (part.type === "text") chars += part.text.length
    else if (part.type === "reasoning") chars += part.text.length
    else chars += part.toolCall.id.length + part.toolCall.name.length + part.toolCall.arguments.length
  }
  return chars
}
