import { runAgent } from "../core/agent.js"
import type { FireworksClient } from "../inference/client.js"
import type { ChatMessage, ContextFile, TokenUsage } from "../inference/types.js"
import type { PromptAdmission, SessionToolActivity } from "../storage/index.js"
import type { ToolCall } from "../tools/index.js"
import type { ParallelClient } from "../web/client.js"
import type { ChatUI } from "./chat-ui.js"
import { estimateAgentContextTokens } from "./context-meter.js"
import { countDiffLines } from "./diff-stats.js"
import type { TranscriptEntry, TranscriptStore } from "./transcript.js"

export type AgentTurnResult =
  | { status: "complete"; messages: ChatMessage[]; toolActivities: SessionToolActivity[] }
  | { status: "interrupted"; messages: ChatMessage[]; toolActivities: SessionToolActivity[] }
  | { status: "error" | "incomplete" }

type AgentTurnOptions = {
  input: string
  admission: PromptAdmission
  client: FireworksClient
  webClient: ParallelClient
  webClientModel: string
  transcript: TranscriptStore
  ui: ChatUI
  cwd: string
  debug: boolean
  signal: AbortSignal
  projectContext: ContextFile[]
  projectContextChars: number
  isExiting: () => boolean
  onContext: (tokens: number) => void
  onDiff: (added: number, removed: number) => void
  onUsage: (usage: TokenUsage) => void | Promise<void>
  onPermissionRequest?: (call: ToolCall) => Promise<boolean>
  onCompletion: () => void
}

export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const { admission, input, signal, transcript, ui } = options
  let assistantText = ""
  let assistantEntry: TranscriptEntry | undefined
  let turnMessages: ChatMessage[] = []
  let completedTurn = false
  let recordedTurn = false
  const toolActivities: SessionToolActivity[] = []
  const toolEntries = new Map<string, { entryId: number; activityIndex: number }>()

  const ensureAssistantEntry = () => {
    assistantEntry ??= transcript.addAssistantMessage("")
    return assistantEntry
  }
  const recordAdmittedPrompt = () => {
    if (recordedTurn) return
    transcript.addMessages([admission.message])
    recordedTurn = true
  }
  const recordCompletedTurn = () => {
    if (recordedTurn) return
    transcript.addMessages(turnMessages)
    recordedTurn = true
  }
  const interrupt = (messages: ChatMessage[] = [admission.message]): AgentTurnResult => {
    if (assistantEntry) transcript.updateEntry(assistantEntry.id, { streaming: false })
    transcript.addAssistantMessage("_Interrupted._")
    turnMessages = messages
    recordCompletedTurn()
    ui.renderTranscript(transcript.entries, { scrollToBottom: true })
    return { status: "interrupted", messages, toolActivities }
  }
  const interruptionResult = (messages: ChatMessage[] = [admission.message]): AgentTurnResult =>
    options.isExiting() ? { status: "interrupted", messages, toolActivities } : interrupt(messages)
  const interrupted = () => options.isExiting() || signal.aborted

  try {
    for await (const event of runAgent(input, transcript.history, {
      client: options.client,
      webClient: options.webClient,
      webClientModel: options.webClientModel,
      cwd: options.cwd,
      debug: options.debug,
      onUsage: options.onUsage,
      signal,
      projectContext: options.projectContext,
      onPermissionRequest: options.onPermissionRequest,
    })) {
      if (event.type === "model") {
        ui.setAgentPhase("working")
        ui.startBusyIndicator()
        continue
      }

      if (event.type === "reasoning") {
        ui.setAgentPhase("thinking")
        continue
      }

      if (event.type === "debug") {
        for (const line of event.message.split("\n")) transcript.addDebugMessage(line)
        ui.renderTranscript(transcript.entries)
        continue
      }

      if (event.type === "delta") {
        ui.setAgentPhase("working")
        assistantText += event.text
        const entry = ensureAssistantEntry()
        transcript.updateEntry(entry.id, { text: assistantText, streaming: true })
        ui.renderTranscript(transcript.entries)
        continue
      }

      if (event.type === "tool") {
        if (event.phase === "start") {
          ui.setAgentPhase("working")
          if (assistantEntry) transcript.updateEntry(assistantEntry.id, { streaming: false })
          assistantEntry = undefined
          assistantText = ""
          const entry = transcript.addToolMessage(event.label, event.activityKind, { toolCallId: event.toolCallId })
          toolActivities.push({
            toolCallId: event.toolCallId,
            activityKind: event.activityKind,
            label: event.label,
          })
          toolEntries.set(event.toolCallId, { entryId: entry.id, activityIndex: toolActivities.length - 1 })
          ui.renderTranscript(transcript.entries)
        }
        if (event.phase === "end" && event.diff) {
          const toolEntry = toolEntries.get(event.toolCallId)
          if (toolEntry) {
            transcript.updateEntry(toolEntry.entryId, { diff: event.diff })
            toolActivities[toolEntry.activityIndex] = {
              ...toolActivities[toolEntry.activityIndex],
              diff: event.diff,
            }
          }
          const diff = countDiffLines(event.diff)
          options.onDiff(diff.added, diff.removed)
          ui.renderTranscript(transcript.entries)
        }
        continue
      }

      if (event.type === "context") {
        options.onContext(
          estimateAgentContextTokens(event.contentChars, event.messageCount, options.projectContextChars),
        )
        continue
      }

      if (event.type === "complete") {
        ui.stopBusyIndicator()
        turnMessages = event.messages
        completedTurn = true
        continue
      }

      if (event.type === "interrupted") {
        return interruptionResult(event.messages)
      }

      if (event.type === "error") {
        if (interrupted()) return interruptionResult()
        ui.stopBusyIndicator()
        const entry = ensureAssistantEntry()
        transcript.updateEntry(entry.id, { text: `Error: ${event.message}`, streaming: false })
        recordAdmittedPrompt()
        ui.renderTranscript(transcript.entries)
        options.onCompletion()
        return { status: "error" }
      }
    }
  } catch (error) {
    if (interrupted()) return interruptionResult(completedTurn ? turnMessages : undefined)
    ui.stopBusyIndicator()
    const entry = ensureAssistantEntry()
    transcript.updateEntry(entry.id, {
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      streaming: false,
    })
    if (completedTurn) recordCompletedTurn()
    else recordAdmittedPrompt()
    ui.renderTranscript(transcript.entries)
    options.onCompletion()
    return { status: "error" }
  }

  if (!completedTurn && interrupted()) return interruptionResult()
  if (!completedTurn) return { status: "incomplete" }

  if (assistantEntry) transcript.updateEntry(assistantEntry.id, { streaming: false })
  recordCompletedTurn()
  options.onCompletion()
  return { status: "complete", messages: turnMessages, toolActivities }
}
