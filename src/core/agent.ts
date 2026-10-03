import { randomUUID } from "node:crypto"
import { unreportedContextLimitError } from "../inference/context-policy.js"
import { ContextOverflowError, describeError } from "../inference/errors.js"
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
  type ToolAction,
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
      action: ToolAction
      subject: string
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
  "recall",
])
const MAX_TOOL_OUTPUT_CHARS = 16_000
/** Past this share of the compaction threshold an estimate is too coarse to trust. */
const RECOUNT_SHARE = 0.5
const REPEATED_FAILURE_NOTICE =
  "\n\nThis exact call has now failed twice with the same error. Change the arguments or take a different step; a third identical attempt ends the turn."
const COWORKER_REPORT_PREFIX = "[Coworker report: "
const COWORKER_FAILURE_PREFIX = "[Coworker failed: "

/** A delivered coworker report is model context, not something the user typed. */
export function isCoworkerReport(message: ChatMessage): boolean {
  if (message.role !== "user" || typeof message.content !== "string") return false
  return (
    message.content.startsWith(COWORKER_REPORT_PREFIX) ||
    message.content.startsWith(COWORKER_FAILURE_PREFIX)
  )
}

type Coworker = {
  toolCallId: string
  title: string
  /** Child events not yet forwarded into the parent's stream. */
  events: AgentEvent[]
  /** Working, then holding the message for the model, then delivered. */
  state: "working" | { report: string } | "delivered"
}

/**
 * The delegated runs of one turn. Each child runs in the background from the moment its `agent`
 * call returns; its events surface through the parent's stream whenever the parent waits on
 * anything, and its report is handed to the model before the next request, or through
 * `wait_coworkers`. The turn does not end while a coworker is still working or unreported.
 */
class Coworkers {
  readonly #runs: Coworker[] = []
  readonly #controller = new AbortController()
  readonly signal: AbortSignal
  #wake = () => {}
  #woken = new Promise<void>((resolve) => {
    this.#wake = resolve
  })

  constructor(parent: AbortSignal | undefined) {
    this.signal = parent
      ? AbortSignal.any([parent, this.#controller.signal])
      : this.#controller.signal
  }

  start(toolCallId: string, title: string, run: AsyncGenerator<AgentEvent>) {
    const coworker: Coworker = { toolCallId, title, events: [], state: "working" }
    this.#runs.push(coworker)
    const settle = (prefix: string, body: string) => {
      coworker.state = { report: `${prefix}${title}]\n\n${body}` }
    }
    void (async () => {
      for await (const event of run) {
        coworker.events.push(event)
        if (event.type === "complete")
          settle(COWORKER_REPORT_PREFIX, lastAssistantText(event.messages))
        if (event.type === "error") settle(COWORKER_FAILURE_PREFIX, event.message)
        if (event.type === "interrupted") settle(COWORKER_FAILURE_PREFIX, "Interrupted.")
        this.#wake()
        this.#woken = new Promise((resolve) => {
          this.#wake = resolve
        })
      }
      // Every run ends with a terminal event; nothing else settles a coworker.
      if (coworker.state === "working") throw new Error("Coworker ended without a report.")
    })()
  }

  /** Resolves once a child has an event to forward. */
  #next() {
    return this.#runs.some((run) => run.events.length > 0) ? Promise.resolve() : this.#woken
  }

  *flush(): Generator<AgentEvent> {
    for (const run of this.#runs) {
      for (const event of run.events.splice(0))
        yield { type: "subagent", toolCallId: run.toolCallId, title: run.title, event }
    }
  }

  /** Any child still working or whose report the model has not received. */
  get pending() {
    return this.#runs.some((run) => run.state !== "delivered")
  }

  get reportReady() {
    return this.#runs.some((run) => typeof run.state === "object")
  }

  get allSettled() {
    return this.#runs.every((run) => run.state !== "working")
  }

  /** The reports ready for delivery, each delivered once. */
  takeReports() {
    return this.#runs.flatMap((run) => {
      if (typeof run.state !== "object") return []
      const { report } = run.state
      run.state = "delivered"
      return [report]
    })
  }

  /** Awaits `promise`, forwarding child events as they arrive. */
  async *during<T>(promise: Promise<T>): AsyncGenerator<AgentEvent, T> {
    while (true) {
      const settled = await Promise.race([promise.then(() => true), this.#next().then(() => false)])
      yield* this.flush()
      if (settled) return await promise
    }
  }

  /** Forwards child events until `ready()` holds, then whatever arrived while forwarding. */
  async *until(ready: () => boolean): AsyncGenerator<AgentEvent> {
    while (!ready()) {
      await this.#next()
      yield* this.flush()
    }
    yield* this.flush()
  }

  cancel() {
    this.#controller.abort()
  }

  /** Cancels what still runs and forwards every remaining child event, so no trace stays open. */
  async *finish() {
    this.cancel()
    yield* this.until(() => this.allSettled)
  }
}

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
  /** Consecutive responses whose tool calls all failed and matched the previous response's. */
  let repeatedFailure = { key: "", count: 0 }
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
  const coworkers = new Coworkers(options.signal)
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
    // The approval surface handles one request at a time, so the parent and its coworkers take
    // turns asking.
    const approve = options.onPermissionRequest
    let approvals: Promise<unknown> = Promise.resolve()
    const toolContext = {
      ...options,
      projectContext,
      skills,
      tools,
      attachments: () => [...(options.attachments?.() ?? []), ...attachments],
      permissionPolicy:
        options.permissionPolicy ?? createPermissionPolicy({ cwd, mode: DEFAULT_PERMISSION_MODE }),
      webSession: { id: options.webSession?.id },
      onPermissionRequest:
        approve &&
        ((request: PermissionRequest) => {
          const approval = approvals.then(() => approve(request))
          approvals = approval.catch(() => undefined)
          return approval
        }),
      coworkers,
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
      yield* coworkers.flush()
      const reports = coworkers.takeReports()
      if (reports.length) {
        messages.push(...reports.map((content): ChatMessage => ({ role: "user", content })))
        yield contextEvent()
      }
      options.signal?.throwIfAborted()
      // A serving tokenizer's count is a full-history request. The previous response's usage is
      // exact for everything but the tool results since, so recount only until an exact base
      // exists or once the estimate nears the threshold.
      if (
        options.client.countTokens &&
        recoveryBudget === undefined &&
        (!observed?.exact || contextTokens(messages) >= threshold * RECOUNT_SHARE)
      ) {
        observed = { tokens: await count(messages), estimate: estimate(messages), exact: true }
        yield contextEvent()
      }
      if (recoveryBudget !== undefined || contextTokens(messages) >= threshold) {
        const budget = recoveryBudget ?? threshold
        const summaryBudget = recoveryBudget === undefined ? undefined : Math.floor(budget / 2)
        recoveryBudget = undefined
        yield { type: "compaction", phase: "start" }
        const result = yield* coworkers.during(
          compactConversation(messages, {
            client: options.client,
            signal: options.signal,
            onUsage: options.onCompactionUsage ?? options.onUsage,
            contextBudget: budget,
            maxInputTokens: summaryBudget,
            countContextTokens: count,
          }),
        )
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
        const stream = options.client.streamChat({
          messages,
          tools,
          systemPrompt,
          projectContext: projectContext.length > 0 ? projectContext : undefined,
          skills: modelSkills,
          outputCapabilities: options.outputCapabilities,
          signal: options.signal,
        })
        while (true) {
          const step = yield* coworkers.during(stream.next())
          if (step.done) break
          const event = step.value
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
        yield* coworkers.finish()
        yield { type: "interrupted", messages: messages.slice(turnStart) }
        return
      }

      yield contextEvent()

      if (
        finishReason === "length" ||
        toolCalls.some((call) => !hasObjectArguments(call.arguments))
      ) {
        // No call in this response has run yet. Earlier completed tool calls remain intact.
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
          yield* coworkers.finish()
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
        // Steering stays open while coworkers work: the model continues once they report.
        const steered = coworkers.pending
          ? await options.steering?.drain()
          : await options.steering?.drainOrClose()
        if (steered?.length) {
          steeringCount += steered.length
          messages.push(...steered)
          attachments.push(...steered.flatMap(userMessageAttachments))
          yield contextEvent()
          continue
        }
        if (coworkers.pending) {
          yield* coworkers.until(() => coworkers.reportReady)
          continue
        }
        // Every coworker has reported, and its trace was forwarded while that request streamed.
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

      // Calls run one at a time so workspace mutations stay ordered; an `agent` call only starts
      // its coworker, so several in one response still explore at once.
      let index = 0
      let aborted = false
      let failedAll = true
      while (index < toolCalls.length && !aborted) {
        aborted = options.signal?.aborted ?? false
        if (aborted) break
        const outcome = yield* executeSingleToolCall(toolCalls[index], toolContext)
        messages.push(outcome.message)
        failedAll &&= outcome.failed
        index += 1
        aborted = outcome.interrupted
      }
      // A model that reissues the exact calls that just failed is not converging: the second
      // repeat is told so, the third ends the turn instead of burning the context on retries.
      const callKey = toolCalls.map((call) => `${call.name} ${call.arguments}`).join("\n")
      repeatedFailure =
        failedAll && !aborted
          ? { key: callKey, count: callKey === repeatedFailure.key ? repeatedFailure.count + 1 : 1 }
          : { key: "", count: 0 }
      if (repeatedFailure.count === 2) {
        const last = messages.at(-1)
        if (last?.role === "tool") last.content += REPEATED_FAILURE_NOTICE
      } else if (repeatedFailure.count === 3) {
        messages.push(...(await closeSteering(options.steering)))
        yield contextEvent()
        yield* coworkers.finish()
        yield {
          type: "error",
          message:
            "The model repeated the same failing tool call three times without changing it. Otis stopped the turn; earlier completed work is preserved.",
          messages: messages.slice(turnStart),
        }
        return
      }
      if (aborted) {
        messages.push(
          ...toolCalls.slice(index).map(interruptedToolMessage),
          ...(await closeSteering(options.steering)),
        )
        yield contextEvent()
        yield* coworkers.finish()
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
    yield* coworkers.finish()
    if (options.signal?.aborted) {
      yield { type: "interrupted", messages: messages.slice(turnStart) }
      return
    }
    yield { type: "error", message: describeError(error), messages: messages.slice(turnStart) }
  } finally {
    coworkers.cancel()
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

type ToolCallOutcome = { message: ChatMessage; interrupted: boolean; failed: boolean }

async function* executeSingleToolCall(
  rawCall: ChatToolCall,
  context: RunAgentOptions & { tools: ToolDefinition[]; coworkers: Coworkers },
): AsyncGenerator<AgentEvent, ToolCallOutcome> {
  const { coworkers } = context
  // Every result but the tool's own output is a failure, which the repeat breaker counts.
  const toolMessage = (content: string, failed = true): ToolCallOutcome => ({
    message: { role: "tool", toolCallId: rawCall.id, content },
    interrupted: false,
    failed,
  })
  const interrupted = () => ({
    message: interruptedToolMessage(rawCall),
    interrupted: true,
    failed: false,
  })

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
    action: activity.action,
    subject: activity.subject,
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
      const approved = yield* coworkers.during(
        context.onPermissionRequest({ call, decision: permission }),
      )
      if (context.signal?.aborted) return interrupted()
      if (!approved) {
        outcome = "denied"
        return toolMessage("Permission denied by user.")
      }
    }

    if (call.name === "wait_coworkers") {
      yield* coworkers.until(() => coworkers.allSettled)
      const reports = coworkers.takeReports()
      result = reports.length
        ? { title: `${reports.length} coworker report(s)`, output: reports.join("\n\n") }
        : { title: "No coworkers are working.", output: "" }
    } else if (call.name === "agent") {
      // The child shares the parent's client, workspace, permission policy, approval handler, and
      // usage sink, and stops with the parent's turn, but starts with a fresh history, receives
      // no steering, and works from the read-only subset of the parent's tools. It runs in the
      // background: every child event surfaces wrapped in a `subagent` envelope so the caller can
      // render the full trace, and only its final report reaches the parent's conversation, as a
      // message before the parent's next request or through `wait_coworkers`.
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
      coworkers.start(
        rawCall.id,
        title,
        runAgent(brief, [], {
          ...context,
          signal: coworkers.signal,
          tools: context.tools.filter((tool) => SUBAGENT_TOOLS.has(tool.name)),
          steering: undefined,
          onCompaction: undefined,
          historyTokens: undefined,
        }),
      )
      result = {
        title,
        output:
          "Coworker started in the background. Its report arrives as a message when it " +
          "finishes; keep working on anything that does not depend on it, or call " +
          "wait_coworkers when you need it.",
      }
    } else {
      result = yield* coworkers.during(
        executeToolCall(call, { ...context, authorizedArtifactPath: permission?.artifactPath }),
      )
    }
    const output =
      result.output.length <= MAX_TOOL_OUTPUT_CHARS
        ? result.output
        : `${result.output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[Tool output truncated to ${MAX_TOOL_OUTPUT_CHARS} characters.]`
    return toolMessage(`${call.name}: ${result.title}\n\n${output}`, false)
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
