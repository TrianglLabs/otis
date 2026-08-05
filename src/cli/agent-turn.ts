import type { FireworksClient } from "../inference/client.js"
import type { ChatMessage, ContextFile, TokenUsage } from "../inference/types.js"
import type { PermissionPolicy, PermissionRequest } from "../permissions/policy.js"
import type { PromptAdmission, SessionToolActivity } from "../storage/index.js"
import type { ParallelClient } from "../web/client.js"
import type { ChatUI } from "./chat-ui.js"
import { estimateAgentContextTokens } from "./context-meter.js"
import { countDiffLines } from "./diff-stats.js"
import type { TranscriptEntry, TranscriptStore } from "./transcript.js"
import { executeTurn } from "./turn-runner.js"

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
  permissionPolicy: PermissionPolicy
  onPermissionRequest: (request: PermissionRequest) => Promise<boolean>
  onCompletion: () => void
}

export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const { admission, input, signal, transcript, ui } = options
  let assistantText = ""
  let assistantEntry: TranscriptEntry | undefined
  let recordedTurn = false
  const toolEntries = new Map<string, number>()

  const ensureAssistantEntry = () => {
    assistantEntry ??= transcript.addAssistantMessage("")
    return assistantEntry
  }
  const recordAdmittedPrompt = () => {
    if (recordedTurn) return
    transcript.addMessages([admission.message])
    recordedTurn = true
  }
  const recordCompletedTurn = (messages: ChatMessage[]) => {
    if (recordedTurn) return
    transcript.addMessages(messages)
    recordedTurn = true
  }
  const interrupt = (messages: ChatMessage[], toolActivities: SessionToolActivity[]): AgentTurnResult => {
    if (assistantEntry) transcript.updateEntry(assistantEntry.id, { streaming: false })
    transcript.addAssistantMessage("_Interrupted._")
    recordCompletedTurn(messages)
    ui.renderTranscript(transcript.entries, { scrollToBottom: true })
    return { status: "interrupted", messages, toolActivities }
  }
  const interruptionResult = (messages: ChatMessage[], toolActivities: SessionToolActivity[]): AgentTurnResult =>
    options.isExiting() ? { status: "interrupted", messages, toolActivities } : interrupt(messages, toolActivities)
  const interrupted = () => options.isExiting() || signal.aborted

  try {
    const result = await executeTurn({
      input,
      history: transcript.history,
      agent: {
        client: options.client,
        webClient: options.webClient,
        webClientModel: options.webClientModel,
        cwd: options.cwd,
        debug: options.debug,
        onUsage: options.onUsage,
        signal,
        projectContext: options.projectContext,
        permissionPolicy: options.permissionPolicy,
        onPermissionRequest: options.onPermissionRequest,
      },
      onEvent: (event) => {
        if (event.type === "model") {
          ui.setAgentPhase("working")
          ui.startBusyIndicator()
          return
        }

        if (event.type === "reasoning") {
          ui.setAgentPhase("thinking")
          return
        }

        if (event.type === "debug") {
          for (const line of event.message.split("\n")) transcript.addDebugMessage(line)
          ui.renderTranscript(transcript.entries)
          return
        }

        if (event.type === "delta") {
          ui.setAgentPhase("working")
          assistantText += event.text
          const entry = ensureAssistantEntry()
          transcript.updateEntry(entry.id, { text: assistantText, streaming: true })
          ui.renderTranscript(transcript.entries)
          return
        }

        if (event.type === "tool") {
          if (event.phase === "start") {
            ui.setAgentPhase("working")
            if (assistantEntry) transcript.updateEntry(assistantEntry.id, { streaming: false })
            assistantEntry = undefined
            assistantText = ""
            const entry = transcript.addToolMessage(event.label, event.activityKind, { toolCallId: event.toolCallId })
            toolEntries.set(event.toolCallId, entry.id)
            ui.renderTranscript(transcript.entries)
          }
          if (event.phase === "end" && event.diff) {
            const toolEntry = toolEntries.get(event.toolCallId)
            if (toolEntry !== undefined) transcript.updateEntry(toolEntry, { diff: event.diff })
            const diff = countDiffLines(event.diff)
            options.onDiff(diff.added, diff.removed)
            ui.renderTranscript(transcript.entries)
          }
          return
        }

        if (event.type === "context") {
          options.onContext(
            estimateAgentContextTokens(event.contentChars, event.messageCount, options.projectContextChars),
          )
          return
        }

        if (event.type === "complete") ui.stopBusyIndicator()
      },
    })

    if (result.status === "interrupted") return interruptionResult(result.messages, result.toolActivities)
    if (result.status === "error") {
      if (interrupted()) return interruptionResult(result.messages, result.toolActivities)
      ui.stopBusyIndicator()
      const entry = ensureAssistantEntry()
      transcript.updateEntry(entry.id, { text: `Error: ${result.message}`, streaming: false })
      recordAdmittedPrompt()
      ui.renderTranscript(transcript.entries)
      options.onCompletion()
      return { status: "error" }
    }
    if (result.status === "incomplete") return { status: "incomplete" }

    if (assistantEntry) transcript.updateEntry(assistantEntry.id, { streaming: false })
    recordCompletedTurn(result.messages)
    options.onCompletion()
    return result
  } catch (error) {
    if (interrupted()) return interruptionResult([admission.message], [])
    ui.stopBusyIndicator()
    const entry = ensureAssistantEntry()
    transcript.updateEntry(entry.id, {
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      streaming: false,
    })
    recordAdmittedPrompt()
    ui.renderTranscript(transcript.entries)
    options.onCompletion()
    return { status: "error" }
  }
}
