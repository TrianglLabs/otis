import { createCliRenderer, getTreeSitterClient, type TreeSitterClient } from "@opentui/core"
import {
  type AppEvent,
  Application,
  type AppStatus,
  formatWorkspaceLabel,
} from "../app/application.js"
import type { PendingPermission } from "../app/conversation.js"
import { SESSION_REASONS } from "../app/sessions.js"
import { describeError } from "../inference/errors.js"
import { listDownloadedLocalModels } from "../inference/gguf-cache.js"
import {
  supportsLlamaCppTarget,
  unsupportedLlamaCppTargetMessage,
} from "../inference/llama-binary.js"
import {
  findLocalModel,
  type LocalModelSpec,
  localModelWeightBytes,
} from "../inference/local-catalog.js"
import { formatMemoryLabel } from "../inference/local-fit.js"
import { createUserMessage } from "../inference/messages.js"
import type { ModelPickerItem } from "../inference/picker-catalog.js"
import { isFastFireworksModel } from "../inference/serving-path.js"
import type { ModelProvider, UserChatMessage } from "../inference/types.js"
import {
  isThemeName,
  saveSelectedTheme,
  saveSubagentPanelVisible,
  saveThinkingVisible,
  THEME_NAMES,
  type ThemeName,
} from "../local/settings.js"
import { calculateLocalStats } from "../local/stats.js"
import { SkillManager } from "../skills/manager.js"
import { AttachmentFlow } from "./attachment-flow.js"
import { createChatUI } from "./chat-ui.js"
import { SetupFlow } from "./setup-flow.js"
import { formatSource, skillCount } from "./skills-cli.js"
import {
  parseSlashCommand,
  type SlashCommand,
  slashCommandRunsImmediately,
  slashCommands,
} from "./slash-commands.js"
import { colors, selectTheme } from "./theme.js"
import {
  contextUsage,
  contextUsageColor,
  formatContextUsage,
  formatModeLabel,
  formatModelName,
  withFastModelMark,
} from "./ui/format.js"
import type { ChatUI, Renderer } from "./ui/types.js"
import { checkForUpdate } from "./update.js"

const UPDATE_CHECK_TIMEOUT_MS = 5_000

type PendingAction =
  | { type: "command"; command: SlashCommand }
  | { type: "model-selection"; model: ModelPickerItem }
  | { type: "session-selection"; sessionId: string }
  | { type: "session-deletion"; sessionId: string }
  | { type: "new-session" }

export class InteractiveApp {
  #app!: Application
  #attachments!: AttachmentFlow
  #renderer!: Renderer
  #ui!: ChatUI
  #setupFlow!: SetupFlow
  readonly #skills = new SkillManager()
  #terminal!: TerminalController
  #busy = false
  #exiting = false
  #quitPromise: Promise<void> | undefined
  #configured = false
  #selectedTheme: ThemeName = "default"
  #thinkingVisible = false
  #subagentPanelVisible = true
  readonly #pendingActions: PendingAction[] = []
  #pendingDrain: Promise<void> | undefined
  #updateCheckController: AbortController | undefined
  /** The status last applied to the screen; the next one is diffed against it. */
  #status: AppStatus | undefined
  #removeShutdownListeners: (() => void) | undefined

  static async start() {
    const app = new InteractiveApp()
    await app.#boot()
  }

  async #boot() {
    this.#app = await Application.create({ isExiting: () => this.#exiting })
    const settings = this.#app.settings
    const models = this.#app.models
    // A backend fallback during a local model start is told once, in the transcript.
    models.onNotice = (message) => {
      this.#app.transcript.addAssistantMessage(message)
      if (!this.#exiting) this.#ui.renderTranscript(this.#app.transcript.entries)
    }
    const localInferenceUnavailableReason = supportsLlamaCppTarget(process)
      ? undefined
      : unsupportedLlamaCppTargetMessage(process)
    selectTheme(settings.theme)
    this.#selectedTheme = settings.theme ?? "default"
    this.#thinkingVisible = settings.thinkingVisible ?? false
    this.#subagentPanelVisible = settings.subagentPanelVisible ?? true
    this.#configured = this.#app.hasConfiguredSelection()
    this.#attachments = new AttachmentFlow({
      cwd: this.#app.cwd,
      isBusy: () => this.#isBusy(),
      app: this.#app,
      ui: () => this.#ui,
      onContextChange: () => this.#updateContextIndicator(),
    })

    this.#renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      targetFps: 60,
      backgroundColor: colors.background,
    })

    let treeSitterClient: TreeSitterClient | undefined
    try {
      treeSitterClient = getTreeSitterClient()
      await treeSitterClient.initialize()
    } catch {
      treeSitterClient = undefined
    }

    const status = this.#app.status()
    this.#ui = createChatUI(this.#renderer, {
      configured: this.#configured,
      localInferenceUnavailableReason,
      commands: slashCommands({ fast: status.fastServing.available }),
      contextLabel: formatContextUsage(
        contextUsage(
          this.#app.contextEstimator()(this.#app.transcript.history),
          models.autoCompactAtTokens(this.#app.selection?.model),
        ),
      ),
      modelLabel: modelLabel(
        this.#app.selection?.model.provider,
        this.#app.selection?.model.displayName,
        this.#app.selection?.model.id ?? "",
      ),
      modeLabel: formatModeLabel(this.#app.permissionMode),
      sessionLabel: "Current session",
      theme: this.#selectedTheme,
      thinkingVisible: this.#thinkingVisible,
      subagentPanelVisible: this.#subagentPanelVisible,
      workspaceLabel: formatWorkspaceLabel(this.#app.cwd),
      treeSitterClient,
      onInputChange: (value) => this.#updateContextIndicator(value),
      onImagePaste: (bytes, mimeType) => this.#attachments.attachPastedImage(bytes, mimeType),
      onAttachmentPathPaste: (value) => this.#attachments.handlePathPaste(value),
      onRemoveLastAttachment: () => this.#attachments.removeLast(),
      onInterrupt: () => this.#app.conversation.stop(),
      onQuit: () => this.#quit(),
      onSetup: () => this.#setupFlow.begin(),
      onSetupInferenceChoice: (choice) => this.#setupFlow.selectInference(choice),
      onSetupLocalInferenceChoice: (choice) => this.#setupFlow.selectLocalInference(choice),
      onSetupSubmit: (apiKey) => {
        void this.#setupFlow.submitCredential(apiKey)
      },
      onPairSetupSubmit: (endpoints) => {
        void this.#setupFlow.submitPairEndpoints(endpoints)
      },
      onCloseModelPicker: () => this.#setupFlow.closeModelPicker(),
      onSelectModel: (model) => {
        void this.#runOrDefer({ type: "model-selection", model }, () => this.#ui.hideModelPicker())
      },
      onNewSession: () => {
        this.#attachments.clear()
        void this.#runOrDefer({ type: "new-session" }, () => this.#ui.hideSessionPicker())
      },
      onDeleteSession: (sessionId) => {
        void this.#runOrDefer({ type: "session-deletion", sessionId })
      },
      onSelectSession: (sessionId) => {
        this.#attachments.clear()
        void this.#runOrDefer({ type: "session-selection", sessionId }, () =>
          this.#ui.hideSessionPicker(),
        )
      },
      onSubmit: (value) => this.#handleInput(value),
      onPreviewTheme: (theme) => this.#previewTheme(theme),
      onCancelThemePreview: () => this.#previewTheme(this.#selectedTheme),
      onToggleMode: () => {
        // The mode applies at once and is remembered; the label follows through status.
        void this.#app.setPermissionMode(this.#app.permissionMode === "ask" ? "auto" : "ask")
      },
    })
    this.#status = status
    this.#app.subscribe((event) => {
      if (event.type === "status") this.#syncStatus()
      else if (event.type !== "transcript") this.#onConversationEvent(event)
    })
    this.#setupFlow = new SetupFlow({
      ui: this.#ui,
      app: this.#app,
      localInferenceUnavailableReason,
      isBusy: () => this.#isBusy(),
      setBusy: (value) => {
        this.#busy = value
        // A prompt parked behind a setup operation runs as soon as the operation ends.
        if (!value) this.#app.conversation.drain()
      },
      onCredentialsChanged: () => {
        this.#ui.showStats()
        void this.#refreshLocalStats()
      },
      onConfigured: () => {
        this.#configured = true
        void this.#refreshLocalStats()
      },
    })
    this.#terminal = new TerminalController(
      this.#renderer,
      () => this.#exiting,
      () => this.#ui.focusInput(),
    )
    this.#terminal.installRecovery()
    const onSignal = () => {
      void this.#quit()
    }
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
    this.#removeShutdownListeners = () => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
    }

    const updateController = new AbortController()
    this.#updateCheckController = updateController
    const updateTimeout = setTimeout(() => updateController.abort(), UPDATE_CHECK_TIMEOUT_MS)
    updateTimeout.unref?.()
    void checkForUpdate({ signal: updateController.signal })
      .then((result) => {
        if (result?.available && !this.#exiting) this.#ui.showUpdateHint()
      })
      .catch(() => {
        // Update check is best-effort; silently ignore network or manifest failures.
      })
      .finally(() => {
        clearTimeout(updateTimeout)
        if (this.#updateCheckController === updateController)
          this.#updateCheckController = undefined
      })

    if (this.#configured) void this.#refreshLocalStats()
    // A saved local or oMLX model still needs its server; the start joins the selection queue, so
    // a model picked meanwhile supersedes it instead of racing it.
    const saved = this.#app.selection?.model
    if (saved && !this.#app.focused.client) {
      const provider = saved.provider
      const name = (provider === "local" && findLocalModel(saved.id)?.displayName) || ""
      try {
        await this.#app.startSavedSelection({ isExiting: () => this.#exiting })
      } catch (error) {
        if (this.#exiting) return
        this.#configured = false
        if (provider === "omlx") {
          this.#app.transcript.addAssistantMessage(
            `Could not connect to oMLX: ${describeError(error)}`,
          )
          this.#setupFlow.begin()
        } else {
          this.#ui.showChatLayout()
          this.#app.transcript.addAssistantMessage(
            `Could not start ${name}: ${describeError(error)}`,
          )
          this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
        }
      }
    }
    if (
      !this.#configured &&
      this.#app.fireworksApiKey &&
      saved?.provider !== "local" &&
      saved?.provider !== "omlx"
    ) {
      this.#setupFlow.begin()
    }

    if (this.#app.transcript.entries.length > 0) {
      this.#ui.showChatLayout()
      this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
    }
  }

  async #handleInput(value: string) {
    if (!value && this.#attachments.pending.count === 0) return

    this.#ui.hideUpdateHint()

    const command = parseSlashCommand(value)
    if (command?.type === "queue") {
      if (command.prompt) await this.#submitPrompt(createUserMessage(command.prompt), "queue")
      return
    }
    if (command) {
      if (this.#isBusy() && !slashCommandRunsImmediately(command)) {
        this.#ui.clearInput()
        this.#pendingActions.push({ type: "command", command })
        return
      }
      await this.#runSlashCommand(command)
      await this.#drainPendingActions()
      return
    }
    if (!this.#configured) {
      this.#setupFlow.begin()
      return
    }
    let message: UserChatMessage
    try {
      message = await this.#attachments.prompt(value)
    } catch (error) {
      this.#attachments.showMessage(`Could not send attachments: ${describeError(error)}`)
      return
    }
    await this.#submitPrompt(message, "send")
  }

  /**
   * Hands a prompt to the conversation: steered or queued behind running work, started otherwise.
   * A setup operation's busy window (catalog loads, key checks) is not the model's, so a prompt
   * typed during one is parked and runs when it ends; /queue parks explicitly behind a busy turn.
   * Anything the gate refuses is told, not dropped.
   */
  async #submitPrompt(message: UserChatMessage, mode: "send" | "queue") {
    const conversation = this.#app.conversation
    const blocked = this.#app.admissionGate()
    if (blocked) {
      this.#ui.showTransientHint(` ${blocked} `)
      this.#ui.focusInput()
      return
    }
    let delivery: "started" | "steered" | "queued"
    try {
      if ((this.#busy && !conversation.busy) || (mode === "queue" && this.#isBusy())) {
        await conversation.queue(message)
        delivery = "queued"
      } else {
        if (!conversation.busy) this.#ui.showChatLayout()
        delivery = (await conversation.submit(message)).delivery
      }
    } catch {
      // The conversation already recorded the failure in the transcript.
      this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
      return
    }
    this.#attachments.clear()
    this.#ui.clearInput()
    this.#updateContextIndicator()
    this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
    if (delivery !== "started") return
    await conversation.idle()
    await this.#drainPendingActions()
  }

  /**
   * Session opens and fresh starts wait only for a setup operation: during a turn they open beside
   * the working session. Everything else waits for the turn too.
   */
  async #runOrDefer(pending: PendingAction, hidePicker?: () => void) {
    const opensSession = pending.type === "session-selection" || pending.type === "new-session"
    if (opensSession ? this.#busy : this.#isBusy()) {
      hidePicker?.()
      this.#pendingActions.push(pending)
      return
    }
    await this.#runPendingAction(pending)
    await this.#drainPendingActions()
  }

  /** Runs the actions deferred during busy work, once idle; a drain in flight is shared. */
  #drainPendingActions(): Promise<void> {
    if (this.#pendingDrain) return this.#pendingDrain
    if (this.#isBusy() || this.#exiting || this.#pendingActions.length === 0)
      return Promise.resolve()
    this.#pendingDrain = this.#runPendingActions().finally(() => {
      this.#pendingDrain = undefined
    })
    return this.#pendingDrain
  }

  async #runPendingActions() {
    while (!this.#isBusy() && !this.#exiting) {
      const pending = this.#pendingActions.shift()
      if (!pending) return
      await this.#runPendingAction(pending)
    }
  }

  async #runPendingAction(pending: PendingAction) {
    switch (pending.type) {
      case "command":
        await this.#runSlashCommand(pending.command)
        return
      case "model-selection":
        await this.#setupFlow.selectModel(pending.model)
        return
      case "session-selection":
        await this.#selectSession(pending.sessionId)
        return
      case "session-deletion":
        await this.#deleteSession(pending.sessionId)
        return
      case "new-session":
        this.#startNewSession()
    }
  }

  async #runSlashCommand(command: SlashCommand) {
    switch (command.type) {
      case "exit":
        await this.#quit()
        return
      case "theme":
        await this.#selectThemeCommand(command.name)
        return
      case "model": {
        this.#ui.clearInput()
        await this.#setupFlow.openModelPicker(true, { background: this.#isBusy() })
        return
      }
      case "settings": {
        this.#ui.clearInput()
        if (command.setting === "hosted") {
          this.#setupFlow.configureHostedInference()
        } else if (command.setting === "pair" || command.setting === "servers") {
          this.#setupFlow.configurePairInference()
        } else if (command.setting === "debug") {
          const app = this.#app
          app.debug = !app.debug
          this.#ui.showTransientHint(` Debug mode ${app.debug ? "on" : "off"} `)
          this.#ui.focusInput()
        } else if (command.setting === "subagents") {
          await this.#setPanelVisible("subagents", !this.#subagentPanelVisible)
        } else if (command.setting === "theme") {
          this.#openThemeMenu()
        } else if (command.setting === "delete-model") {
          if (command.modelId) {
            void this.#deleteLocalModel(command.modelId)
            return
          }
          const models = await listDownloadedLocalModels()
          if (models.length === 0) {
            this.#ui.showTransientHint(" No downloaded local models. ")
            this.#ui.focusInput()
            return
          }
          this.#showLocalModelDeleteMenu(models)
        } else {
          await this.#openSettingsMenu()
        }
        return
      }
      case "fast":
        await this.#toggleFastServing()
        return
      case "history":
        this.#ui.clearInput()
        try {
          this.#ui.showSessionPicker(await this.#listSessions())
        } catch (error) {
          this.#reportSessionError("Could not load sessions", error)
        }
        return
      case "new":
        this.#ui.clearInput()
        this.#attachments.clear()
        this.#startNewSession()
        return
      case "home":
        this.#ui.clearInput()
        this.#ui.showHomeLayout()
        void this.#refreshLocalStats()
        this.#ui.focusInput()
        return
      case "thinking":
        await this.#setPanelVisible("thinking", !this.#thinkingVisible)
        return
      case "skills":
        this.#ui.clearInput()
        await this.#runSkillsCommand(command)
        return
      case "effort": {
        const state = this.#app.models.thinkingState(this.#app.selection?.model)
        this.#ui.clearInput()
        if (!state) {
          this.#ui.showTransientHint(" Thinking effort is unavailable for this model ")
          return
        }
        if (!command.level) {
          this.#ui.showTransientHint(
            ` Thinking: ${state.selected}. Use /effort ${[...state.levels, "default"].join(" | ")} `,
          )
          return
        }
        try {
          await this.#app.setLocalThinking(state.modelId, command.level)
          this.#ui.showTransientHint(` Thinking effort: ${command.level} `)
        } catch (error) {
          this.#ui.showTransientHint(` ${describeError(error)} `)
        }
        this.#ui.focusInput()
        return
      }
      case "queue":
        return
      case "compact":
        this.#ui.clearInput()
        await this.#runCompaction(command.instructions)
        return
    }
  }

  /**
   * The conversation streams, mapped onto the screen; status changes arrive separately. Only the
   * focused session draws; another session's completion rings and is marked in the picker, and its
   * approval request names it.
   */
  #onConversationEvent(event: Exclude<AppEvent, { type: "status" | "transcript" }>) {
    if (this.#exiting) return
    const ui = this.#ui
    const app = this.#app
    if (event.runtime !== app.focused.id) {
      if (event.type === "busy") this.#syncStatus()
      else if (event.type === "settled") {
        this.#terminal.notifyCompletion()
        const title = app.runtimes.find((runtime) => runtime.id === event.runtime)
        ui.showTransientHint(` Done: ${title?.sessions.activeLabel() ?? "session"} `)
      } else if (event.type === "permission") this.#showPermission(event.request)
      return
    }
    switch (event.type) {
      case "busy":
        ui.setBusy(event.busy)
        if (event.busy) return
        ui.stopBusyIndicator()
        ui.focusInput()
        void this.#drainPendingActions()
        return
      case "indicator":
        if (event.active) ui.startBusyIndicator()
        else ui.stopBusyIndicator()
        return
      case "phase":
        ui.setAgentPhase(event.phase)
        return
      case "context": {
        const usage = contextUsage(
          event.tokens,
          app.models.autoCompactAtTokens(app.selection?.model),
        )
        ui.setContextLabel(formatContextUsage(usage), contextUsageColor(usage.percent))
        return
      }
      case "permission":
        this.#showPermission(event.request)
        return
      case "render":
        ui.renderTranscript(
          app.transcript.entries,
          event.scrollToBottom ? { scrollToBottom: true } : undefined,
        )
        return
      case "subagents":
        ui.renderSubagents(app.subagents.all)
        return
      case "admitted":
        ui.showChatLayout()
        this.#attachments.clear()
        this.#syncStatus()
        this.#updateContextIndicator()
        ui.clearInput()
        ui.renderTranscript(app.transcript.entries, { scrollToBottom: true })
        return
      case "settled":
        ui.renderTranscript(app.transcript.entries)
        this.#updateContextIndicator()
        if (event.result.status === "complete" || event.result.status === "error")
          this.#terminal.notifyCompletion()
        return
    }
  }

  /** The broker's head, from any session; one from another session is prefixed with its title. */
  #showPermission(request: PendingPermission | null) {
    if (!request) {
      this.#ui.hidePermissionPrompt()
      return
    }
    const label =
      request.runtime === this.#app.focused.id
        ? request.label
        : `[${request.sessionTitle}] ${request.label}`
    void this.#ui
      .showPermissionPrompt(label)
      .then((allow) => this.#app.permissions.respond(request.id, allow))
  }

  async #runCompaction(instructions?: string) {
    if (this.#busy || !this.#app.focused.client) return
    const refused = await this.#app.compact(instructions)
    if (refused) {
      this.#ui.showTransientHint(` ${refused} `)
      return
    }
    this.#ui.showChatLayout()
    this.#syncStatus()
    this.#updateContextIndicator()
  }

  #quit() {
    this.#quitPromise ??= (async () => {
      this.#exiting = true
      this.#removeShutdownListeners?.()
      this.#removeShutdownListeners = undefined
      this.#updateCheckController?.abort()
      this.#ui.hidePermissionPrompt()
      try {
        await this.#setupFlow.shutdown()
        await this.#app.shutdown()
      } finally {
        this.#renderer.destroy()
      }
    })()
    return this.#quitPromise
  }

  async #refreshLocalStats() {
    try {
      const stats = await calculateLocalStats()
      if (!this.#exiting) this.#ui.setStats(stats)
    } catch {
      // A damaged or temporarily unavailable local stats file must not block the CLI.
    }
  }

  #listSessions() {
    return this.#app.sessions.listPickerItems(this.#app.openSessions())
  }

  /** Opens beside a working session, or focuses one already open; the screen follows either way. */
  async #selectSession(sessionId: string) {
    const previous = this.#app.focused
    try {
      const result = await this.#app.openSession(sessionId)
      if (result === "locked") {
        this.#reportSessionError("Could not open session", new Error(SESSION_REASONS.locked))
      } else {
        if (this.#app.focused !== previous) this.#app.closeIfEmpty(previous)
        this.#reflectSession()
      }
    } catch (error) {
      this.#reportSessionError("Could not open session", error)
    }
  }

  async #deleteSession(sessionId: string) {
    const wasCurrent = this.#app.sessions.current?.id === sessionId
    try {
      const result = await this.#app.deleteSession(sessionId)
      if (result !== "deleted") {
        this.#reportSessionError("Could not delete session", new Error(SESSION_REASONS[result]))
      } else if (wasCurrent) {
        this.#reflectSession()
      }
    } catch (error) {
      this.#reportSessionError("Could not delete session", error)
    }
    try {
      this.#ui.showSessionPicker(await this.#listSessions())
    } catch {
      // Keep the current picker state if disk re-sync fails after the primary action.
    }
  }

  #startNewSession() {
    if (this.#busy) return
    this.#app.openNew()
    this.#ui.hideSessionPicker()
    this.#reflectSession()
    this.#ui.focusInput()
  }

  /** Shows the focused session, whichever runtime it lives in and whether or not it is mid-turn. */
  #reflectSession() {
    const { sessions, conversation } = this.#app
    const ui = this.#ui
    this.#syncStatus()
    ui.showChatLayout()
    ui.renderTranscript(sessions.transcript.entries, { scrollToBottom: true })
    ui.renderSubagents(sessions.subagents.all)
    ui.setBusy(conversation.busy)
    ui.setAgentPhase(conversation.phase)
    if (!conversation.busy) ui.stopBusyIndicator()
    this.#updateContextIndicator()
    ui.focusInput()
  }

  /**
   * Applies what changed since the last applied status to the screen. Every setter is a plain
   * assignment, so diffing keeps the terminal quiet during streaming and makes the call sites
   * that mutate model or session state indifferent to what the screen shows.
   */
  #syncStatus() {
    if (this.#exiting) return
    const prev = this.#status
    const next = this.#app.status()
    this.#status = next
    if (!prev) return
    const ui = this.#ui
    const label = (model: AppStatus["model"]) =>
      model ? modelLabel(model.provider, model.displayName ?? model.id, model.id) : "No model"
    if (label(prev.model) !== label(next.model)) ui.setModelLabel(label(next.model))
    if (next.modelState === "ready") this.#configured = true
    if (prev.fastServing.available !== next.fastServing.available)
      ui.setCommands(slashCommands({ fast: next.fastServing.available }))
    if (prev.modelLoad !== next.modelLoad) {
      if (prev.modelLoad && prev.modelLoad.modelId !== next.modelLoad?.modelId)
        ui.setModelPickerStatus(prev.modelLoad.modelId, undefined)
      if (next.modelLoad) ui.setModelPickerStatus(next.modelLoad.modelId, next.modelLoad.status)
    }
    const session = (status: AppStatus) => status.session?.title ?? "Current session"
    if (session(prev) !== session(next)) ui.setSessionLabel(session(next))
    if (prev.diffs.added !== next.diffs.added || prev.diffs.removed !== next.diffs.removed)
      ui.setDiffStats(next.diffs.added, next.diffs.removed)
    if (prev.contextTokens !== next.contextTokens || prev.contextLimit !== next.contextLimit)
      this.#updateContextIndicator()
    if (prev.permissionMode !== next.permissionMode)
      ui.setModeLabel(formatModeLabel(next.permissionMode))
    if (prev.working !== next.working) ui.setBackgroundWorking(next.working)
  }

  #reportSessionError(prefix: string, error: unknown) {
    this.#say(`Error: ${prefix}: ${describeError(error)}`)
    this.#ui.focusInput()
  }

  /** A note from Otis itself, shown in the transcript wherever the user is. */
  #say(text: string) {
    this.#ui.showChatLayout()
    this.#app.transcript.addAssistantMessage(text)
    this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
  }

  async #openSettingsMenu() {
    const downloaded = (await listDownloadedLocalModels()).length > 0
    if (this.#exiting) return
    const items = [
      {
        name: "Hosted inference",
        description: this.#app.fireworksApiKey ? "Replace API key" : "Add API key",
        submission: "/settings hosted",
      },
      {
        name: "Local servers",
        description:
          this.#app.pairEndpoints.ollama ||
          this.#app.pairEndpoints.lmStudio ||
          this.#app.models.omlx
            ? "Reconnect or choose model"
            : "Connect a local model server",
        submission: "/settings servers",
      },
      ...(downloaded
        ? [
            {
              name: "Delete local model",
              description: "Choose a downloaded model",
              submission: "/settings delete-model",
            },
          ]
        : []),
      {
        name: "Theme",
        description: this.#selectedTheme,
        submission: "/settings theme",
      },
      {
        name: "Debug mode",
        description: this.#app.debug ? "On" : "Off",
        submission: "/settings debug",
      },
      {
        name: "Subagents",
        description: this.#subagentPanelVisible ? "Shown" : "Hidden",
        submission: "/settings subagents",
      },
    ]
    this.#ui.showCommandSubmenu(items, { onBack: () => this.#ui.showSlashCommandMenu() })
    this.#ui.focusInput()
  }

  /**
   * `/skills` lists the collections Otis manages with a row to install more; a collection opens
   * its own Update and Remove rows. The loaded skills print to the transcript, where a long list
   * reads better than a menu.
   */
  async #runSkillsCommand(command: Extract<SlashCommand, { type: "skills" }>) {
    if (
      command.action === "install" ||
      command.action === "update" ||
      command.action === "remove"
    ) {
      const { action, target } = command
      let text: string
      try {
        if (action === "install")
          text = `Installed ${formatSource(await this.#skills.install(target))}.`
        else if (action === "update") {
          const [source] = await this.#skills.update(target)
          text = `Updated ${formatSource(source)}.`
        } else {
          const source = await this.#skills.remove(target)
          text = `Removed ${source.id} and ${skillCount(source.skills.length)}.`
        }
        await this.#app.reloadSkills()
      } catch (error) {
        this.#ui.showTransientHint(` ${describeError(error)} `)
        this.#ui.focusInput()
        return
      }
      this.#say(text)
      return
    }
    const summary = await this.#app.listSkills(this.#skills)
    if (this.#exiting) return
    if (command.action === "list") {
      const rows = summary.skills.map((skill) => {
        const origin = typeof skill.origin === "string" ? skill.origin : skill.origin.collection
        return `- **${skill.name}** (${origin}): ${skill.description}`
      })
      this.#say(rows.length > 0 ? rows.join("\n") : "No skills are loaded.")
      return
    }
    const source =
      command.action === "source" && summary.sources.find((entry) => entry.id === command.target)
    if (source) {
      this.#ui.showCommandSubmenu(
        [
          { name: "Update", description: source.url, submission: `/skills update ${source.id}` },
          {
            name: "Remove",
            description: skillCount(source.skills.length),
            submission: `/skills remove ${source.id}`,
          },
        ],
        { onBack: () => void this.#runSkillsCommand({ type: "skills" }) },
      )
    } else {
      this.#ui.showCommandSubmenu(
        [
          {
            name: "Install",
            description: "Paste a Git link after the command",
            draft: "/skills install ",
          },
          {
            name: "Loaded skills",
            description: skillCount(summary.skills.length),
            submission: "/skills list",
          },
          ...summary.sources.map((entry) => ({
            name: entry.id,
            description: `${skillCount(entry.skills.length)} · ${entry.url}`,
            submission: `/skills source ${entry.id}`,
          })),
        ],
        { onBack: () => this.#ui.showSlashCommandMenu() },
      )
    }
    this.#ui.focusInput()
  }

  #openThemeMenu() {
    this.#ui.clearInput()
    this.#ui.showCommandSubmenu(
      THEME_NAMES.map((theme) => ({
        name: theme,
        description: theme === this.#selectedTheme ? "Active" : "",
        submission: `/settings theme ${theme}`,
      })),
      { onBack: () => void this.#openSettingsMenu() },
    )
    this.#ui.focusInput()
  }

  #showLocalModelDeleteMenu(models: readonly LocalModelSpec[]) {
    const selected = this.#app.selection?.model
    this.#ui.showCommandSubmenu(
      models.map((model) => {
        const active = selected?.provider === "local" && model.id === selected.id ? "Active · " : ""
        const size = formatMemoryLabel(localModelWeightBytes(model))
        return {
          name: model.displayName,
          description: `${active}${model.quant} · ${size}`,
          submission: `/settings delete-model ${model.id}`,
        }
      }),
      { onBack: () => void this.#openSettingsMenu() },
    )
    this.#ui.focusInput()
  }

  /**
   * Deletes a downloaded model through the application; an active model's deletion reopens the
   * picker so the user chooses a replacement. The application refuses while a selection is open
   * (the download in progress is not cancelled) and reports why.
   */
  async #deleteLocalModel(modelId: string) {
    if (this.#exiting || this.#isBusy()) return
    const spec = findLocalModel(modelId)
    if (!spec) return
    this.#busy = true
    this.#ui.setBusy(true)
    let deleted: Awaited<ReturnType<Application["deleteLocalModel"]>>
    try {
      deleted = await this.#app.deleteLocalModel(modelId)
    } catch (error) {
      if (!this.#exiting) {
        this.#ui.showTransientHint(` ${describeError(error)} `)
        this.#ui.focusInput()
      }
      return
    } finally {
      this.#busy = false
      if (!this.#exiting) this.#ui.setBusy(false)
    }
    if (this.#exiting) return
    if (deleted.wasActive) {
      this.#configured = false
      await this.#setupFlow.openModelPicker(true)
      if (!this.#exiting)
        this.#ui.showTransientHint(` Deleted ${spec.displayName}. Choose another model. `)
      return
    }
    if (deleted.remaining.length > 0) this.#showLocalModelDeleteMenu(deleted.remaining)
    else {
      this.#ui.showTransientHint(` Deleted ${spec.displayName}. `)
      this.#ui.focusInput()
    }
  }

  #isBusy() {
    return this.#busy || this.#app.conversation.busy
  }

  #updateContextIndicator(pendingInput = "") {
    const pendingMessage = createUserMessage(pendingInput, this.#attachments.pending.items)
    const usage = contextUsage(
      this.#app.contextTokens(
        pendingInput || this.#attachments.pending.items.length > 0 ? pendingMessage : undefined,
      ),
      this.#app.models.autoCompactAtTokens(this.#app.selection?.model),
    )
    this.#ui.setContextLabel(formatContextUsage(usage), contextUsageColor(usage.percent))
  }

  async #selectThemeCommand(value: string) {
    if (!isThemeName(value)) {
      this.#showThemeMessage("Choose a theme with `/settings theme`.")
      return
    }

    try {
      await saveSelectedTheme(value)
      this.#selectedTheme = value
      this.#previewTheme(value)
      this.#ui.clearInput()
      this.#ui.focusInput()
    } catch (error) {
      this.#previewTheme(this.#selectedTheme)
      this.#showThemeMessage(`Could not save theme: ${describeError(error)}`)
    }
  }

  #previewTheme(theme: ThemeName) {
    const previous = selectTheme(theme)
    this.#ui.setTheme(theme, previous)
  }

  async #toggleFastServing() {
    if (!this.#configured || !this.#app.fireworksApiKey || !this.#app.selection) {
      this.#setupFlow.begin()
      return
    }

    this.#ui.clearInput()
    const result = await this.#setupFlow.toggleFastServing()
    this.#ui.focusInput()
    if (result === "error") return
    if (result === "unavailable") {
      this.#ui.showTransientHint(" Fast serving is not available for this model ")
      return
    }
    this.#ui.showTransientHint(result === "on" ? " Fast serving on " : " Fast serving off ")
  }

  /** Thinking traces and the subagent panel share one persisted-toggle lifecycle. */
  async #setPanelVisible(panel: "thinking" | "subagents", visible: boolean) {
    const previous = panel === "thinking" ? this.#thinkingVisible : this.#subagentPanelVisible
    const apply = (value: boolean) => {
      if (panel === "thinking") {
        this.#thinkingVisible = value
        this.#ui.setThinkingVisible(value)
      } else {
        this.#subagentPanelVisible = value
        this.#ui.setSubagentPanelVisible(value)
      }
    }
    apply(visible)
    this.#ui.clearInput()
    this.#ui.focusInput()
    try {
      if (panel === "thinking") await saveThinkingVisible(visible)
      else await saveSubagentPanelVisible(visible)
      this.#ui.showTransientHint(
        panel === "thinking"
          ? ` Thinking traces ${visible ? "shown" : "hidden"} `
          : ` Subagents ${visible ? "shown" : "hidden"} `,
      )
    } catch (error) {
      apply(previous)
      const label = panel === "thinking" ? "thinking visibility" : "subagent panel visibility"
      this.#app.transcript.addAssistantMessage(`Could not save ${label}: ${describeError(error)}`)
      this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
    }
  }

  #showThemeMessage(message: string) {
    this.#ui.clearInput()
    this.#say(message)
    this.#ui.focusInput()
  }
}

function modelLabel(
  provider: ModelProvider | undefined,
  displayName: string | undefined,
  id: string,
) {
  const name = formatModelName(displayName)
  if (provider === "omlx") return `${name} · oMLX`
  if (provider === "pair") return `${name} · NVIDIA PAIR`
  if (provider === "local") return `${name} · Local`
  return withFastModelMark(name, isFastFireworksModel(id))
}

const WAKE_CHECK_INTERVAL_MS = 5_000
const WAKE_REPAINT_THRESHOLD_MS = 15_000

class TerminalController {
  #focused = true

  constructor(
    private readonly renderer: Renderer,
    private readonly isExiting: () => boolean,
    private readonly focusInput: () => void,
  ) {}

  /**
   * Repaints after the terminal regains focus or the machine wakes from sleep, so the frame is
   * never stale.
   */
  installRecovery() {
    let lastWakeCheck = Date.now()
    const onFocus = () => {
      this.#focused = true
      this.repaint()
    }
    const onBlur = () => {
      this.#focused = false
    }
    const wakeCheck = setInterval(() => {
      const now = Date.now()
      if (now - lastWakeCheck > WAKE_REPAINT_THRESHOLD_MS) this.repaint()
      lastWakeCheck = now
    }, WAKE_CHECK_INTERVAL_MS)
    wakeCheck.unref?.()

    this.renderer.on("focus", onFocus)
    this.renderer.on("blur", onBlur)
    this.renderer.once("destroy", () => {
      clearInterval(wakeCheck)
      this.renderer.off("focus", onFocus)
      this.renderer.off("blur", onBlur)
    })
  }

  notifyCompletion() {
    if (!this.#focused && !this.isExiting()) process.stdout.write("\x07")
  }

  private repaint() {
    if (this.isExiting()) return
    try {
      this.renderer.resetSplitFooterForReplay({ clearSavedLines: false })
    } catch {
      this.renderer.requestRender()
    }
    setTimeout(() => {
      if (this.isExiting()) return
      this.renderer.requestRender()
      this.focusInput()
    }, 50).unref?.()
  }
}
