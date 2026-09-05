import type { CompactionResult } from "../core/compaction.js"
import type { SteeringSource } from "../core/steering.js"
import type { InferenceClient } from "../inference/client.js"
import type { ChatMessage, ContextFile, TokenUsage } from "../inference/types.js"
import type { PermissionPolicy, PermissionRequest } from "../permissions/policy.js"
import type { SkillCatalog } from "../skills/index.js"
import type { PromptAdmission, SessionTurnDetails } from "../storage/index.js"
import type { ToolDefinition } from "../tools/index.js"
import type { ParallelClient } from "../web/client.js"
import { countDiffLines } from "./diff-stats.js"
import type { SubagentTraces } from "./subagents.js"
import type { TranscriptStore } from "./transcript.js"
import { TranscriptProjector } from "./transcript-projector.js"
import { executeTurn } from "./turn-runner.js"
import type { ChatUI } from "./ui/types.js"

export type AgentTurnResult =
  | { status: "complete"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "interrupted"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "error"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "incomplete" }

type AgentTurnOptions = {
  admission: PromptAdmission
  client: InferenceClient
  webClient: ParallelClient
  webClientModel: string
  webSessionId?: string
  transcript: TranscriptStore
  subagents: SubagentTraces
  ui: ChatUI
  cwd: string
  debug: boolean
  signal: AbortSignal
  projectContext: ContextFile[]
  skills: SkillCatalog
  tools: ToolDefinition[]
  autoCompactAtTokens?: number
  onCompaction?: (result: CompactionResult, details: SessionTurnDetails, steeringCount: number) => void | Promise<void>
  onCompactionUsage?: (usage: TokenUsage) => void | Promise<void>
  isExiting: () => boolean
  onContext: (tokens: number) => void
  onDiff: (added: number, removed: number) => void
  onUsage: (usage: TokenUsage) => void | Promise<void>
  permissionPolicy: PermissionPolicy
  onPermissionRequest: (request: PermissionRequest) => Promise<boolean>
  onCompletion: () => void
  steering?: SteeringSource
}

export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const { admission, signal, transcript, subagents, ui } = options
  let projector = new TranscriptProjector(transcript)
  let checkpointed = false
  let recordedTurn = false

  const recordAdmittedPrompt = () => {
    if (recordedTurn) return
    if (!checkpointed) transcript.addMessages([admission.message])
    recordedTurn = true
  }
  const recordCompletedTurn = (messages: ChatMessage[]) => {
    if (recordedTurn) return
    transcript.addMessages(messages)
    recordedTurn = true
  }
  const showError = (message: string) => {
    ui.stopBusyIndicator()
    transcript.updateEntry(projector.ensureAssistantEntry().id, { text: `Error: ${message}`, streaming: false })
    recordAdmittedPrompt()
    ui.renderTranscript(transcript.entries)
    options.onCompletion()
  }
  const interrupt = (messages: ChatMessage[], details: SessionTurnDetails): AgentTurnResult => {
    projector.finishStreaming()
    transcript.addAssistantMessage("_Interrupted._")
    recordCompletedTurn(messages)
    ui.renderTranscript(transcript.entries, { scrollToBottom: true })
    return { status: "interrupted", messages, details }
  }
  const interruptionResult = (messages: ChatMessage[], details: SessionTurnDetails): AgentTurnResult =>
    options.isExiting() ? { status: "interrupted", messages, details } : interrupt(messages, details)
  const interrupted = () => options.isExiting() || signal.aborted

  try {
    const result = await executeTurn({
      input: admission.message,
      history: transcript.history,
      historyDetails: {
        toolActivities: transcript.toolActivitiesFor(transcript.history),
        subagents: subagents.runsFor(transcript.history),
      },
      onCompaction: options.onCompaction,
      agent: {
        client: options.client,
        webClient: options.webClient,
        webClientModel: options.webClientModel,
        webSession: options.webSessionId ? { id: options.webSessionId } : undefined,
        cwd: options.cwd,
        debug: options.debug,
        onUsage: options.onUsage,
        autoCompactAtTokens: options.autoCompactAtTokens,
        onCompactionUsage: options.onCompactionUsage,
        signal,
        projectContext: options.projectContext,
        skills: options.skills,
        tools: options.tools,
        permissionPolicy: options.permissionPolicy,
        onPermissionRequest: options.onPermissionRequest,
        steering: options.steering,
      },
      onEvent: (event) => {
        if (event.type === "compaction") {
          projector.finishStreaming()
          if (event.phase === "start") {
            transcript.addAssistantMessage("Context window filling up — auto-compacting conversation…")
            ui.startBusyIndicator()
          } else {
            const activities = transcript.toolActivitiesFor(event.keptMessages)
            const keptSubagents = subagents.runsFor(event.keptMessages)
            transcript.loadCompacted(event.summary, event.keptMessages, activities)
            subagents.load(keptSubagents)
            ui.renderSubagents(subagents.all)
            projector = new TranscriptProjector(transcript)
            checkpointed = true
          }
          ui.renderTranscript(transcript.entries)
          return
        }
        if (event.type === "model") {
          ui.setAgentPhase("working")
          ui.startBusyIndicator()
          return
        }
        if (event.type === "subagent") {
          subagents.apply(event)
          ui.renderSubagents(subagents.all)
          return
        }
        if (event.type === "context") {
          options.onContext(event.tokens)
          return
        }
        if (event.type === "complete") {
          ui.stopBusyIndicator()
          return
        }

        if (event.type === "reasoning" && event.phase === "start") ui.setAgentPhase("thinking")
        if (event.type === "delta" || (event.type === "tool" && event.phase === "start")) ui.setAgentPhase("working")
        if (event.type === "tool" && event.phase === "end" && event.diff) {
          const diff = countDiffLines(event.diff)
          options.onDiff(diff.added, diff.removed)
        }
        // No scrollToBottom here: reasoning and text stream continuously, and force-scrolling would re-engage the
        // sticky scroll and trap users who scrolled up. The sticky scroll already follows when at the bottom.
        if (projector.apply(event)) ui.renderTranscript(transcript.entries)
      },
    })

    if (result.status === "interrupted") return interruptionResult(result.messages, result.details)
    if (result.status === "error") {
      if (interrupted()) return interruptionResult(result.messages, result.details)
      const messages = result.messages.length > 0 ? result.messages : checkpointed ? [] : [admission.message]
      recordCompletedTurn(messages)
      showError(result.message)
      return { ...result, messages }
    }
    if (result.status === "incomplete") return { status: "incomplete" }

    projector.finishStreaming()
    recordCompletedTurn(result.messages)
    options.onCompletion()
    return result
  } catch (error) {
    if (interrupted()) return interruptionResult(checkpointed ? [] : [admission.message], {})
    showError(error instanceof Error ? error.message : String(error))
    return { status: "error", messages: checkpointed ? [] : [admission.message], details: {} }
  }
}
