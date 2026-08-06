import type { AgentEvent } from "../core/agent.js"
import type { OpenAICompatibleReasoningField, TokenUsage } from "../inference/types.js"

export const HEADLESS_EVENT_VERSION = 1
export type HeadlessOutputFormat = "plain" | "json" | "jsonl"

export type HeadlessResult = {
  status: "complete" | "interrupted" | "error"
  output: string
  sessionId?: string
  model: string
  usage: TokenUsage
  durationMs: number
  error?: string
}

export type HeadlessReasoningTrace = {
  id: string
  field: OpenAICompatibleReasoningField
  text: string
  startedAt: string
  endedAt?: string
  durationMs?: number
}

type OutputStream = {
  write(chunk: string): unknown
  once?(event: "drain", listener: () => void): unknown
}

export class HeadlessReporter {
  readonly #reasoning = new Map<string, HeadlessReasoningTrace>()

  constructor(
    private readonly format: HeadlessOutputFormat,
    private readonly stdout: OutputStream,
    private readonly stderr: OutputStream,
    private readonly options: { includeReasoning?: boolean } = {},
  ) {}

  async event(event: AgentEvent) {
    if (event.type === "reasoning" && this.options.includeReasoning) await this.reasoningEvent(event)
    if (this.format === "jsonl") {
      const payload = publicEvent(event, this.options.includeReasoning === true)
      if (payload) await this.writeJsonLine(payload)
      return
    }
    if (this.format === "plain" && event.type === "tool") {
      const suffix =
        event.phase === "end" && event.outcome && event.outcome !== "completed" ? ` (${event.outcome})` : ""
      await writeOutput(this.stderr, `${event.phase === "start" ? "→" : "✓"} ${event.label}${suffix}\n`)
    }
  }

  async usage(usage: TokenUsage) {
    if (this.format === "jsonl") await this.writeJsonLine({ type: "usage", usage })
  }

  async finish(result: HeadlessResult) {
    if (this.format === "plain") {
      if (result.output) {
        await writeOutput(this.stdout, `${result.output}${result.output.endsWith("\n") ? "" : "\n"}`)
      }
      if (result.error) await writeOutput(this.stderr, `Error: ${result.error}\n`)
      return
    }
    if (this.format === "json") {
      await writeOutput(
        this.stdout,
        `${JSON.stringify({ version: HEADLESS_EVENT_VERSION, ...this.withReasoning(result) })}\n`,
      )
      return
    }
    await this.writeJsonLine({ type: "result", ...this.withReasoning(result) })
  }

  private async reasoningEvent(event: Extract<AgentEvent, { type: "reasoning" }>) {
    if (event.phase === "start") {
      this.#reasoning.set(event.reasoningId, {
        id: event.reasoningId,
        field: event.field,
        text: "",
        startedAt: event.startedAt,
      })
      return
    }
    const trace = this.#reasoning.get(event.reasoningId)
    if (!trace) return
    if (event.phase === "delta") {
      trace.text += event.text
      return
    }
    trace.endedAt = event.endedAt
    trace.durationMs = event.durationMs
    if (this.format === "plain" && trace.text) {
      await writeOutput(this.stderr, `Thinking:\n${trace.text}${trace.text.endsWith("\n") ? "" : "\n"}`)
    }
  }

  private withReasoning(result: HeadlessResult) {
    const reasoning = [...this.#reasoning.values()]
    return this.options.includeReasoning && reasoning.length > 0 ? { ...result, reasoning } : result
  }

  private async writeJsonLine(value: Record<string, unknown>) {
    await writeOutput(
      this.stdout,
      `${JSON.stringify({ version: HEADLESS_EVENT_VERSION, timestamp: new Date().toISOString(), ...value })}\n`,
    )
  }
}

async function writeOutput(stream: OutputStream, chunk: string) {
  if (stream.write(chunk) !== false || !stream.once) return
  await new Promise<void>((resolve) => stream.once?.("drain", resolve))
}

function publicEvent(event: AgentEvent, includeReasoning: boolean): Record<string, unknown> | undefined {
  if (event.type === "model") return { type: "model_start" }
  if (event.type === "reasoning") {
    if (!includeReasoning) return event.phase === "delta" ? { type: "reasoning" } : undefined
    if (event.phase === "start") {
      return {
        type: "reasoning_start",
        reasoningId: event.reasoningId,
        field: event.field,
        startedAt: event.startedAt,
      }
    }
    if (event.phase === "delta") {
      return { type: "reasoning_delta", reasoningId: event.reasoningId, text: event.text }
    }
    return {
      type: "reasoning_end",
      reasoningId: event.reasoningId,
      endedAt: event.endedAt,
      durationMs: event.durationMs,
    }
  }
  if (event.type === "delta") return { type: "assistant_delta", text: event.text }
  if (event.type === "context") {
    return { type: "context", messageCount: event.messageCount, contentChars: event.contentChars }
  }
  if (event.type === "debug") return { type: "debug", message: event.message }
  if (event.type === "error") return { type: "error", message: event.message }
  if (event.type === "interrupted") return { type: "interrupted" }
  if (event.type === "complete") return { type: "turn_complete" }
  return {
    type: event.phase === "start" ? "tool_start" : "tool_end",
    toolCallId: event.toolCallId,
    name: event.name,
    activityKind: event.activityKind,
    label: event.label,
    ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(event.diff ? { diff: event.diff } : {}),
  }
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
}

export function addUsage(total: TokenUsage, usage: TokenUsage): TokenUsage {
  return {
    promptTokens: total.promptTokens + usage.promptTokens,
    completionTokens: total.completionTokens + usage.completionTokens,
    totalTokens: total.totalTokens + usage.totalTokens,
  }
}
