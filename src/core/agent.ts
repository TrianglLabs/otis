import { randomUUID } from "node:crypto"
import { unreportedContextLimitError } from "../inference/context-policy.js"
import { ContextOverflowError } from "../inference/errors.js"
import { lastAssistantText, userMessageAttachments } from "../inference/messages.js"
import { hasObjectArguments } from "../inference/openai-compat.js"
import { buildSystemPrompt } from "../inference/system-prompt.js"
import type {
  AssistantContentPart,
  ChatMessage,
  ChatToolCall,
  ContextFile,
  InferenceClient,
  ReasoningContentPart,
  ReasoningTraceEvent,
  StreamChatOptions,
  TokenUsage,
  UserChatMessage,
} from "../inference/types.js"
import {
  createPermissionPolicy,
  DEFAULT_PERMISSION_MODE,
  type PermissionPolicy,
  type PermissionRequest,
} from "../permissions/policy.js"
import { loadSkillCatalog, type SkillCatalog } from "../skills/catalog.js"
import {
  describeToolCall,
  executeToolCall,
  parseSerializedToolCall,
  TOOL_DEFINITIONS,
  type ToolActivityKind,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
  type ToolName,
  type ToolResult,
} from "../tools/index.js"
import {
  autoCompactThreshold,
  type CompactionResult,
  compactConversation,
  compactionSummaryMessage,
  messagesContentChars,
  requestContextEstimator,
} from "./compaction.js"
import { loadProjectContext } from "./context.js"

export type AgentEvent =
  | { type: "context"; messageCount: number; contentChars: number; tokens: number }
  | { type: "compaction"; phase: "start" }
  | ({ type: "compaction"; phase: "complete"; messages: ChatMessage[] } & CompactionResult)
  | { type: "debug"; message: string }
  | { type: "model"; phase: "start" | "retry" }
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
      artifact?: ToolResult["artifact"]
      outcome?: "completed" | "denied" | "failed"
    }
  /** An event from a delegated child run, identified by the parent's `agent` tool call. */
  | { type: "subagent"; toolCallId: string; title: string; event: AgentEvent }
  /**
   * Terminal messages contain only the continuation after the latest compaction, or the full
   * turn otherwise.
   */
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
  /** Last observed size of this history in the current application session, for the same client. */
  historyTokens?: number
  autoCompactAtTokens?: number
  /**
   * Whether a limit reported in an overflow error is the serving window (Fireworks, managed
   * llama.cpp, oMLX) rather than one PAIR node's allocation, which is never cluster metadata.
   */
  trustReportedContextLength?: boolean
  onCompaction?: (
    result: CompactionResult,
    steeringCount: number,
    messages: ChatMessage[],
  ) => void | Promise<void>
  onCompactionUsage?: (usage: TokenUsage) => void | Promise<void>
  steering?: SteeringSource
  outputCapabilities?: StreamChatOptions["outputCapabilities"]
}

/**
 * Subagents explore and research only; they never mutate the workspace, run commands, or
 * delegate again.
 */
const SUBAGENT_TOOLS: ReadonlySet<ToolName> = new Set([
  "read",
  "grep",
  "glob",
  "web_search",
  "web_read",
  "skill",
])
const MAX_TOOL_OUTPUT_CHARS = 16_000

export async function* runAgent(
  input: string | UserChatMessage,
  history: ChatMessage[] = [],
  options: RunAgentOptions,
): AsyncGenerator<AgentEvent> {
  const userMessage: UserChatMessage =
    typeof input === "string" ? { role: "user", content: input } : input
  let messages: ChatMessage[] = [...history, userMessage]
  const attachments = messages.flatMap((message) =>
    message.role === "user" ? userMessageAttachments(message) : [],
  )
  let turnStart = history.length
  let steeringCount = 0
  let recoveryAttempts = 0
  let retrying = false
  let overflowAttempts = 0
  let recoveryBudget: number | undefined
  let contextEvent: (() => AgentEvent) | undefined
  // The response being streamed; a failed stream still publishes what it produced.
  let content: AssistantContentPart[] = []
  let reasoning: (ReasoningContentPart & { id: string; startedAt: string }) | undefined
  const endReasoning = (): ReasoningTraceEvent[] => {
    if (!reasoning) return []
    const endedAt = new Date()
    reasoning.endedAt = endedAt.toISOString()
    const event: ReasoningTraceEvent = {
      type: "reasoning",
      phase: "end",
      reasoningId: reasoning.id,
      endedAt: reasoning.endedAt,
      durationMs: Math.max(0, endedAt.getTime() - Date.parse(reasoning.startedAt)),
    }
    reasoning = undefined
    return [event]
  }
  try {
    const cwd = options.cwd ?? process.cwd()
    const projectContext = options.projectContext ?? loadProjectContext(cwd)
    const skills =
      options.skills ?? (await loadSkillCatalog(cwd, { dataDirectory: options.dataDirectory }))
    const tools = (options.tools ?? TOOL_DEFINITIONS).filter(
      (tool) => tool.name !== "skill" || skills.skills.length > 0,
    )
    const modelSkills = tools.some((tool) => tool.name === "skill") ? skills.skills : []
    const systemPrompt = buildSystemPrompt(
      projectContext,
      undefined,
      modelSkills,
      tools,
      options.outputCapabilities,
    )
    const requestOptions = { tools, systemPrompt, signal: options.signal }
    const estimate = requestContextEstimator(requestOptions)
    const count = (value: ChatMessage[]) =>
      options.client.countTokens?.({ ...requestOptions, messages: value }) ?? estimate(value)
    let observed: { tokens: number; estimate: number; exact?: boolean } | undefined =
      options.historyTokens === undefined
        ? undefined
        : { tokens: options.historyTokens, estimate: estimate(history) }
    const contextTokens = (value: ChatMessage[]) => {
      const estimated = estimate(value)
      return observed
        ? Math.max(observed.exact ? 0 : estimated, observed.tokens + estimated - observed.estimate)
        : estimated
    }
    const threshold = options.autoCompactAtTokens ?? autoCompactThreshold()
    contextEvent = (): AgentEvent => ({
      type: "context",
      messageCount: messages.length,
      contentChars: messagesContentChars(messages),
      tokens: contextTokens(messages),
    })
    const toolContext = {
      ...options,
      projectContext,
      skills,
      tools,
      attachments: () => [...(options.attachments?.() ?? []), ...attachments],
      permissionPolicy:
        options.permissionPolicy ?? createPermissionPolicy({ cwd, mode: DEFAULT_PERMISSION_MODE }),
      webSession: { id: options.webSession?.id },
    }
    // The approval surface handles one request at a time, so concurrent children must take
    // turns asking.
    const approve = options.onPermissionRequest
    let approvals: Promise<unknown> = Promise.resolve()
    const concurrentContext = {
      ...toolContext,
      onPermissionRequest:
        approve &&
        ((request: PermissionRequest) => {
          const approval = approvals.then(() => approve(request))
          approvals = approval.catch(() => undefined)
          return approval
        }),
    }
    yield contextEvent()

    while (true) {
      const steered = await options.steering?.drain()
      if (steered?.length) {
        steeringCount += steered.length
        messages.push(...steered)
        attachments.push(...steered.flatMap(userMessageAttachments))
        yield contextEvent()
      }
      options.signal?.throwIfAborted()
      if (options.client.countTokens && recoveryBudget === undefined) {
        observed = { tokens: await count(messages), estimate: estimate(messages), exact: true }
        yield contextEvent()
      }
      if (recoveryBudget !== undefined || contextTokens(messages) >= threshold) {
        const budget = recoveryBudget ?? threshold
        const summaryBudget = recoveryBudget === undefined ? undefined : Math.floor(budget / 2)
        recoveryBudget = undefined
        yield { type: "compaction", phase: "start" }
        const result = await compactConversation(messages, {
          client: options.client,
          signal: options.signal,
          onUsage: options.onCompactionUsage ?? options.onUsage,
          contextBudget: budget,
          maxInputTokens: summaryBudget,
          countContextTokens: count,
        })
        // Persist the checkpoint before committing it to live context or sending another request.
        const segment = messages.slice(turnStart)
        await options.onCompaction?.(result, steeringCount, segment)
        messages = [compactionSummaryMessage(result.summary), ...result.keptMessages]
        turnStart = messages.length
        observed = undefined
        yield { type: "compaction", phase: "complete", ...result, messages: segment }
        yield contextEvent()
        // Steering received during summarization must be drained before the next request.
        continue
      }
      yield { type: "model", phase: retrying ? "retry" : "start" }
      options.signal?.throwIfAborted()
      retrying = false

      content = []
      const toolCalls: ChatToolCall[] = []
      let usage: TokenUsage | undefined
      let finishReason: string | undefined
      try {
        for await (const event of options.client.streamChat({
          messages,
          tools,
          systemPrompt,
          projectContext: projectContext.length > 0 ? projectContext : undefined,
          skills: modelSkills,
          outputCapabilities: options.outputCapabilities,
          signal: options.signal,
        })) {
          if (event.type === "text_delta") {
            yield* endReasoning()
            const previous = content.at(-1)
            if (previous?.type === "text") previous.text += event.text
            else content.push({ type: "text", text: event.text })
            yield { type: "delta", text: event.text }
          } else if (event.type === "reasoning_delta") {
            if (reasoning?.field !== event.field) yield* endReasoning()
            if (!reasoning) {
              const startedAt = new Date().toISOString()
              reasoning = {
                type: "reasoning",
                id: randomUUID(),
                text: "",
                field: event.field,
                startedAt,
              }
              content.push(reasoning)
              yield {
                type: "reasoning",
                phase: "start",
                reasoningId: reasoning.id,
                field: event.field,
                startedAt,
              }
            }
            reasoning.text += event.text
            yield { type: "reasoning", phase: "delta", reasoningId: reasoning.id, text: event.text }
          } else if (event.type === "tool_call") {
            yield* endReasoning()
            toolCalls.push(event.toolCall)
            content.push({ type: "tool_call", toolCall: event.toolCall })
          } else if (event.type === "usage") {
            usage = event.usage
            await options.onUsage?.(event.usage)
          } else if (event.type === "finish") finishReason = event.reason
        }
      } catch (error) {
        // An interrupted stream still publishes its partial output through the interrupted path
        // below.
        if (!options.signal?.aborted) {
          const tokens = contextTokens(messages)
          // A rejection with no reported limit, on input already inside half the budget, means
          // the serving window is smaller than local agent use supports.
          if (
            error instanceof ContextOverflowError &&
            error.contextLength === undefined &&
            tokens <= threshold / 2
          ) {
            throw unreportedContextLimitError(tokens)
          }
          // Once output has been published, replaying this request could duplicate visible work.
          if (
            !(error instanceof ContextOverflowError) ||
            content.length > 0 ||
            usage ||
            overflowAttempts >= 2
          ) {
            throw error
          }
          overflowAttempts += 1
          // Reduce the rejected request to the reported window when that is the serving limit;
          // otherwise to the rejected size, never treating one PAIR node's limit as cluster
          // metadata.
          const reported =
            options.trustReportedContextLength && error.contextLength !== undefined
              ? autoCompactThreshold(error.contextLength)
              : tokens
          recoveryBudget = Math.max(1, Math.floor(Math.min(threshold, reported)))
          retrying = true
          continue
        }
      }
      yield* endReasoning()
      const response = content
      content = []
      if (response.length > 0) messages.push({ role: "assistant", content: response })
      if (usage) {
        observed = {
          tokens: usage.promptTokens + usage.completionTokens,
          estimate: estimate(messages),
          exact: options.client.countTokens !== undefined,
        }
      }

      if (options.signal?.aborted) {
        messages.push(
          ...toolCalls.map(interruptedToolMessage),
          ...(await closeSteering(options.steering)),
        )
        yield contextEvent()
        yield { type: "interrupted", messages: messages.slice(turnStart) }
        return
      }

      yield contextEvent()

      if (
        finishReason === "length" ||
        toolCalls.some((call) => !hasObjectArguments(call.arguments))
      ) {
        // No call in this response has run yet. Earlier successful tool batches remain intact.
        const notice =
          "This response was incomplete or contained invalid tool arguments. None of its tool calls were executed. " +
          "Continue using smaller tool calls and shorter output; do not repeat earlier successful actions."
        if (toolCalls.length) {
          messages.push(
            ...toolCalls.map(
              (call): ChatMessage => ({ role: "tool", toolCallId: call.id, content: notice }),
            ),
          )
        } else {
          messages.push({ role: "assistant", content: [{ type: "text", text: notice }] })
        }
        if (recoveryAttempts >= 1) {
          messages.push(...(await closeSteering(options.steering)))
          yield {
            type: "error",
            message:
              "The model couldn’t produce a complete, usable response. Otis stopped without running the incomplete actions. Earlier completed work is preserved.",
            messages: messages.slice(turnStart),
          }
          return
        }
        recoveryAttempts += 1
        retrying = true
        continue
      }

      if (toolCalls.length === 0) {
        const steered = await options.steering?.drainOrClose()
        if (steered?.length) {
          steeringCount += steered.length
          messages.push(...steered)
          attachments.push(...steered.flatMap(userMessageAttachments))
          yield contextEvent()
          continue
        }
        if (!response.some((part) => part.type === "text" && part.text.trim().length > 0)) {
          yield {
            type: "error",
            message: "The model returned an empty response.",
            messages: messages.slice(turnStart),
          }
          return
        }
        yield { type: "complete", messages: messages.slice(turnStart) }
        return
      }

      // Adjacent `agent` calls run concurrently because each delegates read-only work to an
      // isolated child; every other call runs one at a time so workspace mutations stay ordered.
      let index = 0
      let aborted = false
      while (index < toolCalls.length && !aborted) {
        aborted = options.signal?.aborted ?? false
        if (aborted) break
        let end = index + 1
        if (toolCalls[index].name === "agent") {
          while (end < toolCalls.length && toolCalls[end].name === "agent") end += 1
        }
        const batch = toolCalls.slice(index, end)
        const outcomes: ToolCallOutcome[] = []
        if (batch.length === 1) outcomes.push(yield* executeSingleToolCall(batch[0], toolContext))
        else {
          const runs = batch.map((call) => executeSingleToolCall(call, concurrentContext))
          const pending = new Map(
            runs.map((run, i) => [i, run.next().then((step) => ({ i, step }))] as const),
          )
          while (pending.size > 0) {
            const { i, step } = await Promise.race(pending.values())
            if (step.done) {
              pending.delete(i)
              outcomes[i] = step.value
            } else {
              pending.set(
                i,
                runs[i].next().then((step) => ({ i, step })),
              )
              yield step.value
            }
          }
        }
        messages.push(...outcomes.map((outcome) => outcome.message))
        index = end
        aborted = outcomes.some((outcome) => outcome.interrupted)
      }
      if (aborted) {
        messages.push(
          ...toolCalls.slice(index).map(interruptedToolMessage),
          ...(await closeSteering(options.steering)),
        )
        yield contextEvent()
        yield { type: "interrupted", messages: messages.slice(turnStart) }
        return
      }
      yield contextEvent()
    }
  } catch (error) {
    // Partial output stays in the record, as after an interruption, and every call it left
    // unanswered is closed so the history never carries a dangling tool call.
    yield* endReasoning()
    if (content.length > 0) messages.push({ role: "assistant", content })
    messages.push(
      ...unansweredToolCalls(messages.slice(turnStart)).map(failedToolMessage),
      ...(await closeSteering(options.steering)),
    )
    if (contextEvent) yield contextEvent()
    if (options.signal?.aborted) {
      yield { type: "interrupted", messages: messages.slice(turnStart) }
      return
    }
    yield {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      messages: messages.slice(turnStart),
    }
  }
}

function unansweredToolCalls(messages: readonly ChatMessage[]) {
  const pending = new Map<string, ChatToolCall>()
  for (const message of messages) {
    if (message.role === "tool") pending.delete(message.toolCallId)
    else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool_call") pending.set(part.toolCall.id, part.toolCall)
      }
    }
  }
  return [...pending.values()]
}

function failedToolMessage(call: ChatToolCall): ChatMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    content: "Tool call not executed: the response failed before it could run.",
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

type ToolCallOutcome = { message: ChatMessage; interrupted: boolean }

async function* executeSingleToolCall(
  rawCall: ChatToolCall,
  context: RunAgentOptions & { tools: ToolDefinition[] },
): AsyncGenerator<AgentEvent, ToolCallOutcome> {
  const toolMessage = (content: string): ToolCallOutcome => ({
    message: { role: "tool", toolCallId: rawCall.id, content },
    interrupted: false,
  })
  const interrupted = () => ({ message: interruptedToolMessage(rawCall), interrupted: true })

  let call: ToolCall
  try {
    call = parseSerializedToolCall(rawCall.name, rawCall.arguments)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (context.debug)
      yield { type: "debug", message: `Invalid ${rawCall.name} tool call: ${message}` }
    return toolMessage(`Invalid tool call: ${message}`)
  }
  if (!context.tools.some((tool) => tool.name === call.name)) {
    const message = `Tool is not enabled: ${call.name}`
    if (context.debug) yield { type: "debug", message }
    return toolMessage(message)
  }

  const activity = describeToolCall(call)
  const toolEvent = {
    toolCallId: rawCall.id,
    name: call.name,
    activityKind: activity.kind,
    label: activity.label,
  }
  yield { type: "tool", phase: "start", ...toolEvent }

  let result: ToolResult | undefined
  let outcome: "completed" | "denied" | "failed" = "completed"
  try {
    if (context.signal?.aborted) return interrupted()

    const permission = await context.permissionPolicy?.evaluate(call)
    if (permission?.effect === "deny") {
      outcome = "denied"
      const matchedRule = permission.rule
        ? `: ${permission.rule.tool}(${permission.rule.resource ?? "*"})`
        : ""
      return toolMessage(`Permission denied by policy${matchedRule}.`)
    }
    if (permission?.effect === "ask") {
      if (!context.onPermissionRequest) {
        outcome = "denied"
        return toolMessage("Permission approval required, but no approval handler is available.")
      }
      const approved = await context.onPermissionRequest({ call, decision: permission })
      if (context.signal?.aborted) return interrupted()
      if (!approved) {
        outcome = "denied"
        return toolMessage("Permission denied by user.")
      }
    }

    if (call.name === "agent") {
      // The child shares the parent's client, workspace, permission policy, approval handler,
      // usage sink, and abort signal, but starts with a fresh history, receives no steering, and
      // works from the read-only subset of the parent's tools. Every child event surfaces wrapped
      // in a `subagent` envelope so the caller can render the full trace; the parent's own
      // conversation only receives the child's final report.
      const title = call.input.description
      const brief = [
        "You are an Otis subagent. The main agent delegated the task below and cannot see your work, only your final reply.",
        "You have no access to the main conversation; rely on this brief and your tools.",
        "Your tools are read-only. Do not attempt to modify files or run commands.",
        "When finished, reply with a concise report the main agent can act on directly: concrete findings, exact file paths and line references where relevant, and anything you could not verify. Do not ask questions.",
        "",
        "Task:",
        call.input.prompt,
      ].join("\n")
      const child = runAgent(brief, [], {
        ...context,
        tools: context.tools.filter((tool) => SUBAGENT_TOOLS.has(tool.name)),
        steering: undefined,
        onCompaction: undefined,
        historyTokens: undefined,
      })
      for await (const event of child) {
        yield { type: "subagent", toolCallId: rawCall.id, title, event }
        if (event.type === "complete") result = { title, output: lastAssistantText(event.messages) }
        if (event.type === "interrupted") throw new Error("Subagent interrupted.")
        if (event.type === "error") throw new Error(`Subagent failed: ${event.message}`)
      }
      if (!result) throw new Error("Subagent ended without a result.")
    } else {
      result = await executeToolCall(call, {
        ...context,
        authorizedArtifactPath: permission?.artifactPath,
      })
    }
    const output =
      result.output.length <= MAX_TOOL_OUTPUT_CHARS
        ? result.output
        : `${result.output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[Tool output truncated to ${MAX_TOOL_OUTPUT_CHARS} characters.]`
    return toolMessage(`${call.name}: ${result.title}\n\n${output}`)
  } catch (error) {
    outcome = "failed"
    if (context.signal?.aborted) return interrupted()
    const message = error instanceof Error ? error.message : String(error)
    if (context.debug) yield { type: "debug", message: `Tool ${call.name} failed: ${message}` }
    return toolMessage(`Error: ${message}`)
  } finally {
    yield {
      type: "tool",
      phase: "end",
      ...toolEvent,
      diff: result?.diff,
      artifact: result?.artifact,
      outcome,
    }
  }
}

function interruptedToolMessage(call: ChatToolCall): ChatMessage {
  return { role: "tool", toolCallId: call.id, content: "Tool call interrupted by user." }
}

export type SteeringSource = {
  drain(): Promise<UserChatMessage[]>
  drainOrClose(): Promise<UserChatMessage[]>
  close(): Promise<UserChatMessage[]>
}

/**
 * Owns user messages aimed at an active turn. Accepted messages become visible
 * to the agent only after their admission has been durably recorded.
 */
export class SteeringInbox implements SteeringSource {
  #accepting = true
  readonly #pending: {
    message: UserChatMessage
    persisted: Promise<void>
    onConsumed?: () => void
  }[] = []

  constructor(private readonly admit: (message: UserChatMessage) => Promise<void>) {}

  accept(
    message: UserChatMessage,
    onConsumed?: () => void,
  ): { accepted: false } | { accepted: true; persisted: Promise<void> } {
    if (!this.#accepting) return { accepted: false }
    const persisted = Promise.resolve().then(() => this.admit(message))
    this.#pending.push({ message, persisted, onConsumed })
    return { accepted: true, persisted }
  }

  async drain() {
    const pending = this.#pending.splice(0)
    await Promise.all(pending.map((item) => item.persisted))
    for (const item of pending) item.onConsumed?.()
    return pending.map((item) => item.message)
  }

  drainOrClose() {
    if (this.#pending.length > 0) return this.drain()
    this.#accepting = false
    return Promise.resolve([])
  }

  close() {
    this.#accepting = false
    return this.drain()
  }
}
