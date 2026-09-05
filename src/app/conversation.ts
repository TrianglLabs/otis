import { type CompactionResult, compactConversation } from "../core/compaction.js"
import { SteeringInbox, type SteeringSource } from "../core/steering.js"
import { providerTools } from "../core/subagent.js"
import type { InferenceClient } from "../inference/client.js"
import type { ChatMessage, ContextFile, TokenUsage, UserChatMessage } from "../inference/types.js"
import type { PermissionPolicy, PermissionRequest } from "../permissions/policy.js"
import type { SkillCatalog } from "../skills/index.js"
import type { JsonlSession, PromptAdmission, SessionTurnDetails } from "../storage/index.js"
import type { ToolDefinition } from "../tools/index.js"
import type { ParallelClient } from "../web/client.js"
import { countDiffLines } from "./diff-stats.js"
import type { ModelHost } from "./models.js"
import type { SessionCoordinator } from "./sessions.js"
import type { SubagentTraces } from "./subagents.js"
import type { TranscriptStore } from "./transcript.js"
import { TranscriptProjector } from "./transcript-projector.js"
import { executeTurn } from "./turn-runner.js"

export type ConversationTurnResult =
  | { status: "complete"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "interrupted"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "error"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "incomplete" }

export type ConversationSink = {
  renderTranscript(options?: { scrollToBottom?: boolean }): void
  renderSubagents(): void
  setPhase(phase: "thinking" | "working"): void
  startBusy(): void
  stopBusy(): void
}

export type ConversationTurnOptions = {
  admission: PromptAdmission
  client: InferenceClient
  webClient: ParallelClient
  webClientModel: string
  webSessionId?: string
  transcript: TranscriptStore
  subagents: SubagentTraces
  sink: ConversationSink
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

export async function runConversationTurn(options: ConversationTurnOptions): Promise<ConversationTurnResult> {
  const { admission, signal, transcript, subagents, sink } = options
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
    sink.stopBusy()
    transcript.updateEntry(projector.ensureAssistantEntry().id, { text: `Error: ${message}`, streaming: false })
    recordAdmittedPrompt()
    sink.renderTranscript()
    options.onCompletion()
  }
  const interrupt = (messages: ChatMessage[], details: SessionTurnDetails): ConversationTurnResult => {
    projector.finishStreaming()
    transcript.addAssistantMessage("_Interrupted._")
    recordCompletedTurn(messages)
    sink.renderTranscript({ scrollToBottom: true })
    return { status: "interrupted", messages, details }
  }
  const interruptionResult = (messages: ChatMessage[], details: SessionTurnDetails): ConversationTurnResult =>
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
        onPermissionRequest: (request) => withAbort(options.onPermissionRequest(request), signal),
        steering: options.steering,
      },
      onEvent: (event) => {
        if (event.type === "compaction") {
          projector.finishStreaming()
          if (event.phase === "start") {
            transcript.addAssistantMessage("Context window filling up — auto-compacting conversation…")
            sink.startBusy()
          } else {
            const activities = transcript.toolActivitiesFor(event.keptMessages)
            const keptSubagents = subagents.runsFor(event.keptMessages)
            transcript.loadCompacted(event.summary, event.keptMessages, activities)
            subagents.load(keptSubagents)
            sink.renderSubagents()
            projector = new TranscriptProjector(transcript)
            checkpointed = true
          }
          sink.renderTranscript()
          return
        }
        if (event.type === "model") {
          sink.setPhase("working")
          sink.startBusy()
          return
        }
        if (event.type === "subagent") {
          subagents.apply(event)
          sink.renderSubagents()
          return
        }
        if (event.type === "context") {
          options.onContext(event.tokens)
          return
        }
        if (event.type === "complete") {
          sink.stopBusy()
          return
        }

        if (event.type === "reasoning" && event.phase === "start") sink.setPhase("thinking")
        if (event.type === "delta" || (event.type === "tool" && event.phase === "start")) sink.setPhase("working")
        if (event.type === "tool" && event.phase === "end" && event.diff) {
          const diff = countDiffLines(event.diff)
          options.onDiff(diff.added, diff.removed)
        }
        if (projector.apply(event)) sink.renderTranscript()
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

export type CompactConversationOptions = {
  transcript: TranscriptStore
  subagents: SubagentTraces
  session: JsonlSession
  client: InferenceClient
  instructions?: string
  autoCompactAtTokens: number
  estimateContextTokens: (messages: ChatMessage[]) => number
  signal?: AbortSignal
}

export async function compactConversationTranscript(options: CompactConversationOptions): Promise<CompactionResult> {
  const throughSeq = options.session.events.at(-1)?.seq
  const result = await compactConversation(options.transcript.history, {
    client: options.client,
    instructions: options.instructions,
    targetTokens: Math.floor(options.autoCompactAtTokens / 2),
    maxInputTokens: options.autoCompactAtTokens,
    estimateContextTokens: options.estimateContextTokens,
    onUsage: async (usage) => {
      await options.session.recordUsage(usage, "compaction")
    },
    signal: options.signal,
  })
  const keptToolActivities = options.transcript.toolActivitiesFor(result.keptMessages)
  const keptSubagents = options.subagents.runsFor(result.keptMessages)
  await options.session.compact(
    result.summary,
    result.keptMessages,
    { toolActivities: keptToolActivities, subagents: keptSubagents },
    throughSeq,
  )
  options.transcript.loadCompacted(result.summary, result.keptMessages, keptToolActivities)
  options.subagents.load(keptSubagents)
  return result
}

export type QueuedPrompt = {
  admission: PromptAdmission
  session: JsonlSession
  transcriptEntryId: number
}

export type ConversationHooks = {
  sink: ConversationSink
  debug: boolean
  onReady?: (message: UserChatMessage) => void
  onContext: (tokens: number) => void
  onDiff: (added: number, removed: number) => void
  onPermissionRequest: (request: PermissionRequest) => Promise<boolean>
  onCompletion: () => void
}

export type ConversationOptions = {
  sessions: SessionCoordinator
  transcript: TranscriptStore
  subagents: SubagentTraces
  webClient: ParallelClient
  cwd: string
  models: ModelHost
  projectContext: () => ContextFile[]
  skills: () => SkillCatalog
  permissionPolicy: () => PermissionPolicy
  isExiting: () => boolean
}

type ActiveWork = {
  controller: AbortController
  steering?: SteeringInbox
  task: Promise<unknown>
}

export class Conversation {
  #active: ActiveWork | undefined
  readonly #queued: QueuedPrompt[] = []

  constructor(private readonly options: ConversationOptions) {}

  get busy() {
    return this.#active !== undefined
  }

  cancel() {
    this.#active?.controller.abort()
  }

  async wait() {
    await this.#active?.task
  }

  takeQueued() {
    return this.#queued.shift()
  }

  async queue(message: UserChatMessage): Promise<QueuedPrompt> {
    try {
      const session = await this.options.sessions.ensure()
      const admission = await session.admitPrompt(message)
      const entry = this.options.transcript.addQueuedUserMessage(message)
      const queued = { admission, session, transcriptEntryId: entry.id }
      this.#queued.push(queued)
      return queued
    } catch (error) {
      this.options.transcript.addDebugMessage(
        `Could not queue prompt: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }

  async steer(message: UserChatMessage, onActivated: () => void): Promise<"steered" | "queued"> {
    const active = this.#active
    if (!active?.steering) {
      await this.queue(message)
      return "queued"
    }

    let transcriptEntryId: number | undefined
    const acceptance = active.steering.accept(message, () => {
      if (transcriptEntryId === undefined) return
      this.options.transcript.activatePendingUserMessage(transcriptEntryId)
      onActivated()
    })
    if (!acceptance.accepted) {
      await this.queue(message)
      return "queued"
    }

    const entry = this.options.transcript.addSteeringUserMessage(message)
    transcriptEntryId = entry.id
    try {
      await acceptance.persisted
      return "steered"
    } catch (error) {
      this.options.transcript.removeEntry(entry.id)
      this.options.transcript.addDebugMessage(
        `Could not save steering message: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }

  async start(input: UserChatMessage | QueuedPrompt, hooks: ConversationHooks): Promise<ConversationTurnResult> {
    if (this.#active) return { status: "incomplete" }

    const controller = new AbortController()
    const active: ActiveWork = { controller, task: Promise.resolve() }
    this.#active = active
    const running = this.#runTurn(input, hooks, controller)
    active.task = running
    try {
      return await running
    } finally {
      if (this.#active === active) this.#active = undefined
    }
  }

  async compact(
    instructions: string | undefined,
    estimateContextTokens: (messages: ChatMessage[]) => number,
    onBegin?: () => void,
  ) {
    if (this.#active) return
    const client = this.options.models.client
    if (!client) return

    const controller = new AbortController()
    const active: ActiveWork = { controller, task: Promise.resolve() }
    this.#active = active
    active.task = this.#runCompaction(client, instructions, estimateContextTokens, controller.signal, onBegin)
    try {
      await active.task
    } finally {
      if (this.#active === active) this.#active = undefined
    }
  }

  async #runTurn(
    input: UserChatMessage | QueuedPrompt,
    hooks: ConversationHooks,
    controller: AbortController,
  ): Promise<ConversationTurnResult> {
    let queued: QueuedPrompt | undefined
    let userMessage: UserChatMessage
    if (isQueuedPrompt(input)) {
      queued = input
      userMessage = input.admission.message
    } else {
      userMessage = input
    }
    const client = this.options.models.client
    const provider = this.options.models.selectedProvider
    if (!client || !provider) return { status: "incomplete" }

    let admission: PromptAdmission
    let session: JsonlSession
    try {
      session = queued?.session ?? (await this.options.sessions.ensure())
      admission = queued?.admission ?? (await session.admitPrompt(userMessage))
    } catch (error) {
      this.options.transcript.addAssistantMessage(`Error: ${error instanceof Error ? error.message : String(error)}`)
      return { status: "error", messages: [], details: {} }
    }

    const steering = new SteeringInbox(async (message) => {
      await session.steerPrompt(admission, message)
    })
    if (this.#active?.controller === controller) this.#active.steering = steering

    if (!queued || !this.options.transcript.activatePendingUserMessage(queued.transcriptEntryId)) {
      this.options.transcript.addUserMessage(userMessage)
    }
    hooks.onReady?.(userMessage)

    try {
      const result = await runConversationTurn({
        admission,
        client,
        webClient: this.options.webClient,
        webClientModel: client.model,
        webSessionId: session.id,
        transcript: this.options.transcript,
        subagents: this.options.subagents,
        sink: hooks.sink,
        cwd: this.options.cwd,
        debug: hooks.debug,
        signal: controller.signal,
        projectContext: this.options.projectContext(),
        skills: this.options.skills(),
        tools: providerTools(provider),
        autoCompactAtTokens: this.options.models.autoCompactAtTokens,
        onCompaction: async (compaction, details, steeringCount) => {
          await session.compactTurn(admission, compaction.summary, compaction.keptMessages, details, steeringCount)
        },
        onCompactionUsage: async (usage) => {
          await session.recordUsage(usage, "compaction", admission.promptId)
        },
        isExiting: this.options.isExiting,
        onContext: hooks.onContext,
        onDiff: hooks.onDiff,
        onUsage: async (usage) => {
          await session.recordUsage(usage, "agent", admission.promptId)
        },
        permissionPolicy: this.options.permissionPolicy(),
        onPermissionRequest: hooks.onPermissionRequest,
        onCompletion: hooks.onCompletion,
        steering,
      })

      if (result.status === "interrupted" || result.status === "error") {
        try {
          await session.interruptTurn(admission, result.messages, result.details)
        } catch (error) {
          this.options.transcript.addDebugMessage(
            `Could not save interrupted turn: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        return result
      }

      if (result.status !== "complete") return result

      try {
        await session.completeTurn(admission, result.messages, result.details)
      } catch (error) {
        this.options.transcript.addDebugMessage(
          `Could not save turn: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return result
    } finally {
      try {
        await steering.close()
      } catch (error) {
        this.options.transcript.addDebugMessage(
          `Could not save steering message: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  async #runCompaction(
    client: InferenceClient,
    instructions: string | undefined,
    estimateContextTokens: (messages: ChatMessage[]) => number,
    signal: AbortSignal,
    onBegin?: () => void,
  ) {
    this.options.transcript.addAssistantMessage("Compacting conversation…")
    onBegin?.()
    try {
      const session = await this.options.sessions.ensure()
      await compactConversationTranscript({
        transcript: this.options.transcript,
        subagents: this.options.subagents,
        session,
        client,
        instructions,
        autoCompactAtTokens: this.options.models.autoCompactAtTokens,
        estimateContextTokens,
        signal,
      })
    } catch (error) {
      if (signal.aborted) return
      this.options.transcript.addAssistantMessage(
        `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

function isQueuedPrompt(input: UserChatMessage | QueuedPrompt): input is QueuedPrompt {
  return "admission" in input && "session" in input && "transcriptEntryId" in input
}

function withAbort(decision: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(false)
    signal.addEventListener("abort", onAbort, { once: true })
    decision.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}
