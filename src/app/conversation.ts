import { SteeringInbox } from "../core/agent.js"
import { compactConversation } from "../core/compaction.js"
import { reportedContextLengthIsServing } from "../inference/context-policy.js"
import type {
  ChatMessage,
  ContextFile,
  OutputCapabilities,
  UserChatMessage,
} from "../inference/types.js"
import type { PermissionPolicy, PermissionRequest } from "../permissions/policy.js"
import type { SkillCatalog } from "../skills/index.js"
import type { JsonlSession, PromptAdmission, SessionTurnDetails } from "../storage/index.js"
import { providerTools } from "../tools/index.js"
import type { ParallelClient } from "../web/client.js"
import { type ArtifactStore, sessionArtifactPublisher } from "./artifacts.js"
import type { ModelHost } from "./models.js"
import type { SessionCoordinator } from "./sessions.js"
import type { SubagentTraces } from "./subagents.js"
import { countDiffLines, TranscriptProjector, type TranscriptStore } from "./transcript.js"
import { executeTurn } from "./turn-runner.js"

type ConversationTurnResult =
  | { status: "complete"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "interrupted"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "error"; messages: ChatMessage[]; details: SessionTurnDetails }
  | { status: "incomplete" }

type ConversationSink = {
  renderTranscript(options?: { scrollToBottom?: boolean }): void
  renderSubagents(): void
  setPhase(phase: "thinking" | "working"): void
  startBusy(): void
  stopBusy(): void
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

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
      transcript.addDebugMessage(`Could not queue prompt: ${reason(error)}`)
      throw error
    }
  }

  async steer(message: UserChatMessage, onActivated: () => void): Promise<"steered" | "queued"> {
    const { transcript, artifacts } = this.options
    const steering = this.#active?.steering
    let transcriptEntryId: number | undefined
    const acceptance = steering?.accept(message, () => {
      if (transcriptEntryId === undefined) return
      transcript.activatePendingUserMessage(transcriptEntryId)
      onActivated()
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
      transcript.addDebugMessage(`Could not save steering message: ${reason(error)}`)
      throw error
    }
  }

  /** Runs one unit of work as the active one; its abort controller is what `cancel()` reaches. */
  async #run<T>(work: (active: ActiveWork) => Promise<T>): Promise<T> {
    const active: ActiveWork = { controller: new AbortController(), task: Promise.resolve() }
    this.#active = active
    const task = work(active)
    active.task = task
    try {
      return await task
    } finally {
      if (this.#active === active) this.#active = undefined
    }
  }

  async start(
    input: UserChatMessage | QueuedPrompt,
    hooks: ConversationHooks,
  ): Promise<ConversationTurnResult> {
    if (this.#active) return { status: "incomplete" }
    const { models, transcript, subagents, artifacts } = this.options
    const { sink } = hooks
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
        transcript.addAssistantMessage(`Error: ${reason(error)}`)
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
        hooks.onReady?.(userMessage)
        artifacts.setDirectory(session.artifactDirectory)

        let projector = new TranscriptProjector(transcript)
        let checkpointed = false
        // A prompt that never received a response stays in scrollback only: as model history it
        // would be an unanswered message every later request and compaction has to carry.
        const record = (messages: ChatMessage[]) => {
          if (messages.some((message) => message.role !== "user")) transcript.addMessages(messages)
        }
        const fail = (message: string) => {
          sink.stopBusy()
          transcript.updateEntry(projector.ensureAssistantEntry().id, {
            text: `Error: ${message}`,
            streaming: false,
          })
          projector.finishTurn()
          sink.renderTranscript()
          hooks.onCompletion()
        }
        const interrupted = (messages: ChatMessage[], details: SessionTurnDetails) => {
          projector.finishTurn()
          if (!this.options.isExiting()) {
            transcript.addAssistantMessage("_Interrupted._")
            record(messages)
            sink.renderTranscript({ scrollToBottom: true })
          }
          return { status: "interrupted" as const, messages, details }
        }
        const aborted = () => this.options.isExiting() || signal.aborted

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
              debug: hooks.debug,
              onUsage: async (usage) => {
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
              onPermissionRequest: (request) => {
                if (signal.aborted) return Promise.resolve(false)
                const decision = hooks.onPermissionRequest(request)
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
                  sink.startBusy()
                } else {
                  transcript.loadCompacted(event.summary, event.keptMessages)
                  sink.renderSubagents()
                  projector = new TranscriptProjector(transcript)
                  checkpointed = true
                }
                sink.renderTranscript()
                return
              }
              if (event.type === "model") {
                projector.apply(event)
                sink.startBusy()
                sink.setPhase("working")
                sink.renderTranscript()
                return
              }
              if (event.type === "subagent") {
                subagents.apply(event)
                sink.renderSubagents()
                return
              }
              if (event.type === "context") {
                transcript.observeContext(client, event.tokens)
                hooks.onContext(event.tokens)
                return
              }
              if (event.type === "complete") {
                sink.stopBusy()
                return
              }
              if (event.type === "reasoning" && event.phase === "start") sink.setPhase("thinking")
              if (event.type === "delta" || (event.type === "tool" && event.phase === "start"))
                sink.setPhase("working")
              if (event.type === "tool" && event.phase === "end") {
                if (event.diff) {
                  const diff = countDiffLines(event.diff)
                  hooks.onDiff(diff.added, diff.removed)
                }
                if (event.artifact) artifacts.observeFile(event.artifact)
              }
              if (projector.apply(event)) sink.renderTranscript()
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
            hooks.onCompletion()
            result = turn
          }
        } catch (error) {
          const messages = checkpointed ? [] : [admission.message]
          if (aborted()) result = interrupted(messages, {})
          else {
            fail(reason(error))
            result = { status: "error", messages, details: {} }
          }
        }
        const ended = result.status === "complete" ? "completeTurn" : "interruptTurn"
        try {
          await session[ended](admission, result.messages, result.details)
        } catch (error) {
          const what = result.status === "complete" ? "turn" : "interrupted turn"
          transcript.addDebugMessage(`Could not save ${what}: ${reason(error)}`)
        }
        return result
      } catch (error) {
        transcript.addAssistantMessage(`Error: ${reason(error)}`)
        return { status: "error", messages: [], details: {} }
      } finally {
        try {
          await steering.close()
        } catch (error) {
          transcript.addDebugMessage(`Could not save steering message: ${reason(error)}`)
        }
      }
    })
  }

  async compact(
    instructions: string | undefined,
    countContextTokens: (messages: ChatMessage[]) => number,
    onBegin?: () => void,
  ) {
    if (this.#active) return
    const { models, transcript, subagents } = this.options
    const client = models.client
    if (!client) return
    await this.#run(async ({ controller: { signal } }) => {
      transcript.addAssistantMessage("Compacting conversation…")
      onBegin?.()
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
        transcript.addAssistantMessage(`Compaction failed: ${reason(error)}`)
      }
    })
  }
}
