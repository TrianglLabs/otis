import { SteeringInbox } from "../core/agent.js"
import { compactConversation, NOTHING_TO_COMPACT } from "../core/compaction.js"
import { reportedContextLengthIsServing } from "../inference/context-policy.js"
import { errorMessage } from "../inference/errors.js"
import { estimateTextTokens } from "../inference/messages.js"
import type {
  ChatMessage,
  ContextFile,
  OutputCapabilities,
  UserChatMessage,
} from "../inference/types.js"
import type { PermissionPolicy } from "../permissions/policy.js"
import type { SkillCatalog } from "../skills/catalog.js"
import type { JsonlSession, PromptAdmission } from "../storage/session.js"
import type { SessionTurnDetails } from "../storage/session-events.js"
import { describeToolCall, type ToolActivityKind } from "../tools/activity.js"
import { providerTools } from "../tools/index.js"
import type { ParallelClient } from "../web/client.js"
import { type ArtifactStore, sessionArtifactPublisher } from "./artifacts.js"
import type { ModelHost } from "./models.js"
import type { SessionCoordinator } from "./sessions.js"
import type { SubagentTraces } from "./subagents.js"
import { countDiffLines, TranscriptProjector, type TranscriptStore } from "./transcript.js"
import { executeTurn } from "./turn-runner.js"

export type ConversationTurnResult =
  | { status: "complete"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "interrupted"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "error"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "incomplete" }

export type TurnPhase = "idle" | "thinking" | "working"

/**
 * Generation speed of the latest model request in a turn: time to the first streamed token, and
 * output tokens per second over the streaming interval — estimated from streamed text until the
 * provider's usage makes it exact.
 */
export type TurnSpeed = { prefillMs?: number; tokensPerSecond: number; exact: boolean }

/** Streaming estimates are refreshed at most this often. */
const SPEED_INTERVAL_MS = 500

/** A tool call awaiting the user's approval, as the interface shows it. */
export type PendingPermission = {
  id: number
  label: string
  kind: ToolActivityKind
  resources: string[]
}

/**
 * What an interface needs to follow a conversation: the busy window of a turn or drain loop, the
 * streaming indicator and phase inside it, and the moments the transcript, delegated runs, or an
 * approval request changed. `admitted` fires once the prompt is durably recorded; `settled` after
 * every turn, whatever its outcome.
 */
export type ConversationEvent =
  | { type: "busy"; busy: boolean }
  | { type: "indicator"; active: boolean }
  | { type: "phase"; phase: "thinking" | "working" }
  | { type: "context"; tokens: number }
  | { type: "speed"; speed: TurnSpeed | null }
  | { type: "permission"; request: PendingPermission | null }
  | { type: "render"; scrollToBottom?: boolean }
  | { type: "subagents" }
  | { type: "admitted"; message: UserChatMessage }
  | { type: "settled"; result: ConversationTurnResult }

export type QueuedPrompt = {
  admission: PromptAdmission
  session: JsonlSession
  transcriptEntryId: number
}

type ConversationOptions = {
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
  outputCapabilities?: OutputCapabilities
  artifacts: ArtifactStore
  /** Why a prompt cannot be admitted or the queue driven right now; undefined when it can. */
  gate: () => string | undefined
}

type ActiveWork = {
  controller: AbortController
  steering?: SteeringInbox
  task: Promise<unknown>
}

export class Conversation {
  #active: ActiveWork | undefined
  #draining = false
  #wasBusy = false
  #idleWaiters: (() => void)[] = []
  readonly #queued: QueuedPrompt[] = []
  #permissionSeq = 0
  #pending: { request: PendingPermission; resolve: (allow: boolean) => void } | undefined
  readonly #listeners = new Set<(event: ConversationEvent) => void>()
  /** What the active turn is doing; idle between turns. */
  phase: TurnPhase = "idle"
  /** Generation speed of the latest model request; null until the current turn streams. */
  speed: TurnSpeed | null = null
  /** Session-only debug mode; applies from the next turn. */
  debug = false

  constructor(private readonly options: ConversationOptions) {}

  /** A turn is running, or the drain loop is between turns of a queued backlog. */
  get busy() {
    return this.#active !== undefined || this.#draining
  }

  get draining() {
    return this.#draining
  }

  get permission() {
    return this.#pending?.request ?? null
  }

  subscribe(listener: (event: ConversationEvent) => void) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #emit(event: ConversationEvent) {
    for (const listener of this.#listeners) listener(event)
  }

  #syncBusy() {
    const busy = this.busy
    if (busy === this.#wasBusy) return
    this.#wasBusy = busy
    this.#emit({ type: "busy", busy })
    if (!busy) for (const resolve of this.#idleWaiters.splice(0)) resolve()
  }

  /** Resolves once no turn is running and the backlog driver has exited. */
  idle(): Promise<void> {
    if (!this.busy) return Promise.resolve()
    return new Promise((resolve) => this.#idleWaiters.push(resolve))
  }

  cancel() {
    this.#active?.controller.abort()
  }

  /** Cancels the active work and denies any unanswered approval. */
  stop() {
    this.#settlePending(false)
    this.cancel()
  }

  /** Stale or unknown ids are ignored, so a cancelled request stays denied. */
  respondToPermission(id: number, allow: boolean) {
    if (this.#pending?.request.id === id) this.#settlePending(allow)
  }

  #settlePending(allow: boolean) {
    const pending = this.#pending
    if (!pending) return
    this.#pending = undefined
    pending.resolve(allow)
    this.#emit({ type: "permission", request: null })
  }

  async wait() {
    await this.#active?.task
  }

  takeQueued() {
    return this.#queued.shift()
  }

  /** The next queued prompt without removing it, so a caller can check the backlog first. */
  peekQueued() {
    return this.#queued[0]
  }

  async queue(message: UserChatMessage): Promise<QueuedPrompt> {
    const { sessions, transcript, artifacts } = this.options
    try {
      const session = await sessions.ensure()
      const admission = await session.admitPrompt(message)
      const queued = {
        admission,
        session,
        transcriptEntryId: transcript.addQueuedUserMessage(message).id,
      }
      this.#queued.push(queued)
      artifacts.observeMessage(message)
      return queued
    } catch (error) {
      transcript.addDebugMessage(`Could not queue prompt: ${errorMessage(error)}`)
      throw error
    }
  }

  async steer(message: UserChatMessage): Promise<"steered" | "queued"> {
    const { transcript, artifacts } = this.options
    const steering = this.#active?.steering
    let transcriptEntryId: number | undefined
    const acceptance = steering?.accept(message, () => {
      if (transcriptEntryId === undefined) return
      transcript.activatePendingUserMessage(transcriptEntryId)
      this.#emit({ type: "render", scrollToBottom: true })
    })
    if (!acceptance?.accepted) {
      await this.queue(message)
      return "queued"
    }
    const entry = transcript.addSteeringUserMessage(message)
    transcriptEntryId = entry.id
    try {
      await acceptance.persisted
      artifacts.observeMessage(message)
      return "steered"
    } catch (error) {
      transcript.removeEntry(entry.id)
      transcript.addDebugMessage(`Could not save steering message: ${errorMessage(error)}`)
      throw error
    }
  }

  /**
   * Admits one prompt: steered into the running turn (queued behind it when the inbox is closed),
   * queued behind a parked backlog, or started as a new turn. Throws with the gate's reason when
   * nothing can serve it. steer() and queue() admit the prompt to the session before returning,
   * and a started prompt is acknowledged only after its admission, so an accepted delivery means
   * the prompt is durably recorded; a rejection means nothing was saved and the draft must be kept.
   */
  async submit(message: UserChatMessage): Promise<{ delivery: "started" | "steered" | "queued" }> {
    const blocked = this.options.gate()
    if (blocked) throw new Error(blocked)
    if (this.busy) {
      const delivery = await this.steer(message)
      if (delivery === "queued") this.drain()
      return { delivery }
    }
    // Follow-ups waiting without a driver (parked by a gate that has since lifted) run first: admit
    // the new prompt behind them and restart the driver, preserving send order. The queue is only
    // consumed after the new admission succeeds, so a failed admission leaves the backlog intact.
    if (this.#queued.length > 0) {
      await this.queue(message)
      this.drain()
      return { delivery: "queued" }
    }
    let admit!: () => void
    const admitted = new Promise<"admitted">((resolve) => {
      admit = () => resolve("admitted")
    })
    const settled = this.#drive(message, admit).then(
      () => "settled" as const,
      () => "settled" as const,
    )
    if ((await Promise.race([admitted, settled])) === "settled")
      throw new Error("The prompt could not be submitted.")
    return { delivery: "started" }
  }

  /**
   * Starts a driver for a queued backlog that has none: its admission may have completed after
   * the previous driver exited, or the gate that parked it may have lifted. Idempotent; parks
   * while the gate reports a reason.
   */
  drain() {
    if (this.busy || this.options.gate()) return
    const queued = this.#queued.shift()
    if (queued) void this.#drive(queued)
  }

  /**
   * Runs a prompt and then the backlog behind it: every settled turn hands the next queued prompt
   * back until the queue is empty or the gate parks it. The busy window spans the whole loop.
   */
  async #drive(first: UserChatMessage | QueuedPrompt, onAdmitted?: () => void) {
    let input = first
    this.#draining = true
    this.#syncBusy()
    try {
      for (;;) {
        const result = await this.start(input, onAdmitted)
        onAdmitted = undefined
        this.options.sessions.settleTurn(result)
        this.#emit({ type: "settled", result })
        if (this.options.gate()) return
        const queued = this.#queued.shift()
        if (!queued) return
        input = queued
      }
    } finally {
      this.#draining = false
      this.#syncBusy()
    }
  }

  /** Runs one unit of work as the active one; its abort controller is what `cancel()` reaches. */
  async #run<T>(work: (active: ActiveWork) => Promise<T>): Promise<T> {
    const active: ActiveWork = { controller: new AbortController(), task: Promise.resolve() }
    this.#active = active
    this.#syncBusy()
    const task = work(active)
    active.task = task
    try {
      return await task
    } finally {
      if (this.#active === active) this.#active = undefined
      this.#syncBusy()
    }
  }

  #setPhase(phase: "thinking" | "working") {
    this.phase = phase
    this.#emit({ type: "phase", phase })
  }

  #setSpeed(speed: TurnSpeed | null) {
    this.speed = speed
    this.#emit({ type: "speed", speed })
  }

  async start(
    input: UserChatMessage | QueuedPrompt,
    onAdmitted?: () => void,
  ): Promise<ConversationTurnResult> {
    if (this.#active) return { status: "incomplete" }
    const { models, transcript, subagents, artifacts } = this.options
    return this.#run(async (active) => {
      const { signal } = active.controller
      const queued = "admission" in input ? input : undefined
      const userMessage = "admission" in input ? input.admission.message : input
      const client = models.client
      const provider = models.selectedProvider
      if (!client || !provider) return { status: "incomplete" }

      let admission: PromptAdmission
      let session: JsonlSession
      try {
        session = queued?.session ?? (await this.options.sessions.ensure())
        admission = queued?.admission ?? (await session.admitPrompt(userMessage))
      } catch (error) {
        transcript.addAssistantMessage(`Error: ${errorMessage(error)}`)
        return { status: "error", messages: [], details: {} }
      }

      const steering = new SteeringInbox(async (message) => {
        await session.steerPrompt(admission, message)
      })
      active.steering = steering

      if (!queued || !transcript.activatePendingUserMessage(queued.transcriptEntryId)) {
        transcript.addUserMessage(userMessage)
      }
      if (!queued) artifacts.observeMessage(userMessage)
      try {
        await session.startTurn(admission)
        onAdmitted?.()
        this.#emit({ type: "admitted", message: userMessage })
        artifacts.setDirectory(session.artifactDirectory)

        let projector = new TranscriptProjector(transcript)
        let checkpointed = false
        // A prompt that never received a response stays in scrollback only: as model history it
        // would be an unanswered message every later request and compaction has to carry.
        const record = (messages: ChatMessage[]) => {
          if (messages.some((message) => message.role !== "user")) transcript.addMessages(messages)
        }
        const fail = (message: string) => {
          this.#emit({ type: "indicator", active: false })
          transcript.updateEntry(projector.ensureAssistantEntry().id, {
            text: `Error: ${message}`,
            streaming: false,
          })
          projector.finishTurn()
          this.#emit({ type: "render" })
        }
        const interrupted = (messages: ChatMessage[], details: SessionTurnDetails) => {
          projector.finishTurn()
          if (!this.options.isExiting()) {
            transcript.addAssistantMessage("_Interrupted._")
            record(messages)
            this.#emit({ type: "render", scrollToBottom: true })
          }
          return { status: "interrupted" as const, messages, details }
        }
        const aborted = () => this.options.isExiting() || signal.aborted

        // Per model request: prefill runs from the request to its first token; streamed text is
        // estimated until usage reports the exact completion count over the same interval. The
        // first-token mark is consumed by that usage, so a delegated run's usage (which shares
        // this callback) cannot restate it.
        this.#setSpeed(null)
        let requestAt = 0
        let firstTokenAt = 0
        let streamedTokens = 0
        let speedAt = 0
        const prefill = () => (requestAt ? { prefillMs: firstTokenAt - requestAt } : {})
        const streamed = (text: string) => {
          const now = Date.now()
          if (!firstTokenAt) firstTokenAt = speedAt = now
          streamedTokens += estimateTextTokens(text)
          if (now - speedAt < SPEED_INTERVAL_MS) return
          speedAt = now
          const tokensPerSecond = (streamedTokens * 1000) / (now - firstTokenAt)
          this.#setSpeed({ ...prefill(), tokensPerSecond, exact: false })
        }

        let result: Exclude<ConversationTurnResult, { status: "incomplete" }>
        try {
          const turn = await executeTurn({
            input: admission.message,
            history: transcript.history,
            historyDetails: {
              toolActivities: transcript.toolActivitiesFor(transcript.history),
              subagents: subagents.runsFor(transcript.history),
            },
            onCompaction: async (compaction, details, steeringCount, segment) => {
              await session.compactTurn(
                admission,
                compaction.summary,
                compaction.keptMessages,
                details,
                steeringCount,
                segment,
              )
            },
            agent: {
              client,
              webClient: this.options.webClient,
              webClientModel: client.model,
              webSession: { id: session.id },
              cwd: this.options.cwd,
              artifactPublisher: sessionArtifactPublisher(session),
              attachments: () => artifacts.attachments,
              debug: this.debug,
              onUsage: async (usage) => {
                if (firstTokenAt) {
                  const seconds = Math.max(1, Date.now() - firstTokenAt) / 1000
                  const tokensPerSecond = usage.completionTokens / seconds
                  this.#setSpeed({ ...prefill(), tokensPerSecond, exact: true })
                  firstTokenAt = 0
                }
                await session.recordUsage(usage, "agent", admission.promptId)
              },
              autoCompactAtTokens: models.autoCompactAtTokens,
              trustReportedContextLength: reportedContextLengthIsServing(provider),
              historyTokens: transcript.contextTokens(client),
              onCompactionUsage: async (usage) => {
                await session.recordUsage(usage, "compaction", admission.promptId)
              },
              signal,
              projectContext: this.options.projectContext(),
              skills: this.options.skills(),
              tools: providerTools(provider),
              permissionPolicy: this.options.permissionPolicy(),
              // A pending permission prompt must not outlive the turn: abort resolves it as denied.
              // A previous request that never resolved (an interrupted turn) is denied before a new
              // one is shown.
              onPermissionRequest: (request) => {
                if (signal.aborted) return Promise.resolve(false)
                this.#settlePending(false)
                const activity = describeToolCall(request.call)
                const pending: PendingPermission = {
                  id: ++this.#permissionSeq,
                  label: activity.label,
                  kind: activity.kind,
                  resources: request.decision.resources,
                }
                return new Promise<boolean>((resolve) => {
                  const onAbort = () => this.#settlePending(false)
                  this.#pending = {
                    request: pending,
                    resolve: (allow) => {
                      signal.removeEventListener("abort", onAbort)
                      resolve(allow)
                    },
                  }
                  signal.addEventListener("abort", onAbort, { once: true })
                  this.#emit({ type: "permission", request: pending })
                })
              },
              steering,
              outputCapabilities: this.options.outputCapabilities,
            },
            onEvent: (event) => {
              if (event.type === "compaction") {
                projector.finishStreaming()
                if (event.phase === "start") {
                  transcript.addAssistantMessage(
                    "Context window filling up — auto-compacting conversation…",
                  )
                  this.#emit({ type: "indicator", active: true })
                } else {
                  transcript.loadCompacted(event.summary, event.keptMessages)
                  this.#emit({ type: "subagents" })
                  projector = new TranscriptProjector(transcript)
                  checkpointed = true
                }
                this.#emit({ type: "render" })
                return
              }
              if (event.type === "model") {
                requestAt = Date.now()
                firstTokenAt = 0
                streamedTokens = 0
                projector.apply(event)
                this.#emit({ type: "indicator", active: true })
                this.#setPhase("working")
                this.#emit({ type: "render" })
                return
              }
              if (event.type === "subagent") {
                subagents.apply(event)
                this.#emit({ type: "subagents" })
                return
              }
              if (event.type === "context") {
                transcript.observeContext(client, event.tokens)
                this.#emit({ type: "context", tokens: event.tokens })
                return
              }
              if (event.type === "complete") {
                this.#emit({ type: "indicator", active: false })
                return
              }
              if (event.type === "reasoning" && event.phase === "start") this.#setPhase("thinking")
              if (event.type === "delta" || (event.type === "tool" && event.phase === "start"))
                this.#setPhase("working")
              if (event.type === "delta" || (event.type === "reasoning" && event.phase === "delta"))
                streamed(event.text)
              if (event.type === "tool" && event.phase === "end") {
                if (event.diff) {
                  const diff = countDiffLines(event.diff)
                  this.options.sessions.addDiff(diff.added, diff.removed)
                }
                if (event.artifact)
                  artifacts.observeFile(event.artifact, event.activityKind !== "file_read")
              }
              if (projector.apply(event)) this.#emit({ type: "render" })
            },
          })
          if (turn.status === "interrupted" || (turn.status === "error" && aborted())) {
            result = interrupted(turn.messages, turn.details)
          } else if (turn.status === "error") {
            const messages =
              turn.messages.length > 0 ? turn.messages : checkpointed ? [] : [admission.message]
            record(messages)
            fail(turn.message)
            result = { ...turn, messages }
          } else {
            projector.finishTurn()
            if (turn.status === "incomplete") return { status: "incomplete" }
            record(turn.messages)
            result = turn
          }
        } catch (error) {
          const messages = checkpointed ? [] : [admission.message]
          if (aborted()) result = interrupted(messages, {})
          else {
            fail(errorMessage(error))
            result = { status: "error", messages, details: {} }
          }
        }
        const ended = result.status === "complete" ? "completeTurn" : "interruptTurn"
        try {
          await session[ended](admission, result.messages, result.details)
        } catch (error) {
          const what = result.status === "complete" ? "turn" : "interrupted turn"
          transcript.addDebugMessage(`Could not save ${what}: ${errorMessage(error)}`)
        }
        return result
      } catch (error) {
        transcript.addAssistantMessage(`Error: ${errorMessage(error)}`)
        return { status: "error", messages: [], details: {} }
      } finally {
        this.phase = "idle"
        try {
          await steering.close()
        } catch (error) {
          transcript.addDebugMessage(`Could not save steering message: ${errorMessage(error)}`)
        }
      }
    })
  }

  async compact(
    instructions: string | undefined,
    countContextTokens: (messages: ChatMessage[]) => number,
  ) {
    if (this.#active) return
    const { models, transcript, subagents } = this.options
    const client = models.client
    if (!client) return
    await this.#run(async ({ controller: { signal } }) => {
      transcript.addAssistantMessage("Compacting conversation…")
      this.#emit({ type: "indicator", active: true })
      this.#emit({ type: "render", scrollToBottom: true })
      try {
        const session = await this.options.sessions.ensure()
        const skills = this.options.skills()
        const tools = providerTools(models.selectedProvider ?? "fireworks").filter(
          (tool) => tool.name !== "skill" || skills.skills.length > 0,
        )
        // The checkpoint covers history only; a prompt admitted but not yet started stays a
        // queued turn of its own after it.
        const started = new Set(
          session.events.flatMap((event) =>
            event.type !== "prompt_admitted" && "promptId" in event && event.promptId
              ? [event.promptId]
              : [],
          ),
        )
        let throughSeq: number | undefined
        for (const event of session.events) {
          if (event.type !== "prompt_admitted" || started.has(event.promptId))
            throughSeq = event.seq
        }
        const result = await compactConversation(transcript.history, {
          client,
          instructions,
          contextBudget: models.autoCompactAtTokens,
          countContextTokens: (messages) =>
            client.countTokens?.({
              messages,
              tools,
              skills: tools.some((tool) => tool.name === "skill") ? skills.skills : [],
              projectContext: this.options.projectContext(),
              outputCapabilities: this.options.outputCapabilities,
              signal,
            }) ?? countContextTokens(messages),
          onUsage: async (usage) => {
            await session.recordUsage(usage, "compaction")
          },
          signal,
        })
        const kept = result.keptMessages
        await session.compact(
          result.summary,
          kept,
          {
            toolActivities: transcript.toolActivitiesFor(kept),
            subagents: subagents.runsFor(kept),
          },
          throughSeq,
        )
        transcript.loadCompacted(result.summary, kept)
      } catch (error) {
        if (signal.aborted) return
        const message = errorMessage(error)
        transcript.addAssistantMessage(
          message === NOTHING_TO_COMPACT ? message : `Compaction failed: ${message}`,
        )
      } finally {
        this.#emit({ type: "indicator", active: false })
        this.#emit({ type: "subagents" })
        this.#emit({ type: "render", scrollToBottom: true })
      }
    })
  }
}
