import { createCliRenderer } from "@opentui/core"
import { Application } from "../app/application.js"
import { contextUsage } from "../app/context-usage.js"
import type { ConversationHooks, ConversationSink, QueuedPrompt } from "../app/conversation.js"
import type { PersistSelectionOptions, PreparedModelSelection } from "../app/models.js"
import { formatWorkspaceLabel } from "../app/workspace-label.js"
import { autoCompactThreshold } from "../core/compaction.js"
import { FireworksClient } from "../inference/client.js"
import { deleteLocalGguf, listDownloadedLocalModels } from "../inference/gguf-cache.js"
import { supportsLlamaCppTarget, unsupportedLlamaCppTargetMessage } from "../inference/llama-binary.js"
import {
  catalogModelFromSpec,
  findLocalModel,
  type LocalModelSpec,
  localModelWeightBytes,
} from "../inference/local-catalog.js"
import { formatMemoryLabel } from "../inference/local-fit.js"
import { createUserMessage, summarizeUserMessage } from "../inference/messages.js"
import type { ModelPickerItem, ModelPickerStatus } from "../inference/picker-catalog.js"
import { baseFireworksModelId, isFastFireworksModel } from "../inference/serving-path.js"
import { type CatalogModel, isLocalCatalogModel, type UserChatMessage } from "../inference/types.js"
import {
  clearSelectedModel,
  isThemeName,
  saveSelectedModel,
  saveSelectedTheme,
  saveSubagentPanelVisible,
  saveThinkingVisible,
  type ThemeName,
} from "../local/settings.js"
import { calculateLocalStats } from "../local/stats.js"
import type { PermissionRequest } from "../permissions/policy.js"
import { describeToolCall } from "../tools/index.js"
import { createChatUI } from "./chat-ui.js"
import { contextUsageColor, formatContextUsage } from "./context-meter.js"
import { ImageFlow } from "./image-flow.js"
import { SessionController } from "./session-controller.js"
import { SetupFlow } from "./setup-flow.js"
import { parseSlashCommand, type SlashCommand, slashCommandRunsImmediately, slashCommands } from "./slash-commands.js"
import { initializeTreeSitterClient, TerminalController } from "./terminal.js"
import { colors, selectTheme } from "./theme.js"
import { formatLocalLoadStatus, formatModeLabel, formatModelName, withFastModelMark } from "./ui/format.js"
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
  #images!: ImageFlow
  #renderer!: Renderer
  #ui!: ChatUI
  #sessions!: SessionController
  #setupFlow!: SetupFlow
  #terminal!: TerminalController
  #busy = false
  #debug = false
  #exiting = false
  #quitPromise: Promise<void> | undefined
  #localModelManagementTask: Promise<void> | undefined
  #removeShutdownListeners: (() => void) | undefined
  #configured = false
  #selectedTheme: ThemeName = "default"
  #thinkingVisible = false
  #subagentPanelVisible = true
  #fastServingModels = new Set<string>()
  #fastAvailable = false
  #downloadedModelsAvailable = false
  readonly #pendingActions: PendingAction[] = []
  #drainingPendingActions = false
  #updateCheckController: AbortController | undefined
  #startupModelController: AbortController | undefined
  #localLoadStatus: { modelId: string; status: ModelPickerStatus } | undefined

  static async start() {
    const app = new InteractiveApp()
    await app.#boot()
  }

  async #boot() {
    this.#app = await Application.create({
      isBusy: () => this.#busy,
      isExiting: () => this.#exiting,
    })
    const settings = this.#app.settings
    const models = this.#app.models
    const localInferenceUnavailableReason = supportsLlamaCppTarget(process)
      ? undefined
      : unsupportedLlamaCppTargetMessage(process)
    selectTheme(settings.theme)
    this.#selectedTheme = settings.theme ?? "default"
    this.#thinkingVisible = settings.thinkingVisible ?? false
    this.#subagentPanelVisible = settings.subagentPanelVisible ?? true
    this.#fastServingModels = new Set(settings.fastServingModels ?? [])
    this.#downloadedModelsAvailable = (await listDownloadedLocalModels()).length > 0
    this.#fastAvailable =
      models.selectedProvider === "fireworks" &&
      (Boolean(settings.modelFastId) || isFastFireworksModel(settings.model ?? ""))
    this.#configured = this.#app.hasConfiguredSelection()
    this.#images = new ImageFlow({
      cwd: this.#app.cwd,
      isBusy: () => this.#isBusy(),
      apiKey: () => this.#app.fireworksApiKey,
      selectedModelId: () => this.#app.models.selectedId,
      ui: () => this.#ui,
      transcript: this.#app.transcript,
      onContextChange: () => this.#updateContextIndicator(),
    })
    this.#images.setModelCapability(models.supportsImageInput)

    this.#renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      targetFps: 60,
      backgroundColor: colors.background,
    })

    const treeSitterClient = await initializeTreeSitterClient()

    this.#ui = createChatUI(this.#renderer, {
      configured: this.#configured,
      localInferenceUnavailableReason,
      commands: slashCommands({
        fast: this.#fastAvailable,
      }),
      contextLabel: formatContextUsage(
        contextUsage(this.#app.contextEstimator()(this.#app.transcript.history), models.autoCompactAtTokens),
      ),
      modelLabel:
        models.selectedProvider === "pair"
          ? `${formatModelName(settings.modelDisplayName ?? models.selectedId)} · NVIDIA PAIR`
          : models.selectedProvider === "local"
            ? `${formatModelName(settings.modelDisplayName ?? models.selectedId)} · Local`
            : withFastModelMark(
                formatModelName(settings.modelDisplayName ?? models.selectedId),
                Boolean(models.selectedId && isFastFireworksModel(models.selectedId)),
              ),
      modeLabel: formatModeLabel(this.#app.permissionMode),
      sessionLabel: "Current session",
      theme: this.#selectedTheme,
      thinkingVisible: this.#thinkingVisible,
      subagentPanelVisible: this.#subagentPanelVisible,
      workspaceLabel: formatWorkspaceLabel(this.#app.cwd),
      treeSitterClient,
      onInputChange: (value) => this.#updateContextIndicator(value),
      onImagePaste: (bytes, mimeType) => this.#images.attachPasted(bytes, mimeType),
      onImagePathPaste: (value) => this.#images.handlePathPaste(value),
      onRemoveLastImage: () => this.#images.removeLast(),
      onInterrupt: () => {
        this.#app.conversation.cancel()
      },
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
        void this.#selectModel(model)
      },
      onNewSession: () => {
        this.#startNewSession()
      },
      onDeleteSession: (sessionId) => {
        void this.#deleteSession(sessionId)
      },
      onSelectSession: (sessionId) => {
        void this.#selectSession(sessionId)
      },
      onSubmit: (value) => this.#handleInput(value),
      onPreviewTheme: (theme) => this.#previewTheme(theme),
      onCancelThemePreview: () => this.#previewTheme(this.#selectedTheme),
      onToggleMode: () => this.#toggleMode(),
    })
    this.#sessions = new SessionController({
      sessions: this.#app.sessions,
      ui: this.#ui,
      onTranscriptChange: () => this.#updateContextIndicator(),
    })
    this.#setupFlow = new SetupFlow({
      settings,
      models: this.#app.models,
      localInferenceUnavailableReason,
      isBusy: () => this.#isBusy(),
      setBusy: (value) => {
        this.#busy = value
      },
      onCredentialsChanged: (credentials) => {
        this.#app.fireworksApiKey = credentials.fireworksApiKey
        if (credentials.fireworksApiKey && models.selectedId && models.selectedProvider === "fireworks") {
          models.client = new FireworksClient({
            apiKey: credentials.fireworksApiKey,
            model: models.selectedId,
          })
        }
        this.#ui.showStats()
        void this.#refreshLocalStats()
      },
      onPairEndpointsChanged: (endpoints) => {
        this.#app.pairEndpoints = { ...endpoints }
      },
      persistSelection: (model, options) => this.#persistSelection(model, options),
      localLoadStatus: () => this.#localLoadStatus,
      loadedLocalModel: () =>
        models.activeLocal
          ? { model: models.activeLocal.spec.id, contextLength: models.activeLocal.contextLength }
          : undefined,
      onConfigured: (fireworksKey) => {
        if (fireworksKey) this.#app.fireworksApiKey = fireworksKey
        this.#configured = true
        void this.#refreshLocalStats()
      },
      fastEnabled: (modelId) => this.#fastServingModels.has(baseFireworksModelId(modelId)),
      onFastChanged: (modelId, fast) => {
        const baseModelId = baseFireworksModelId(modelId)
        if (fast) this.#fastServingModels.add(baseModelId)
        else this.#fastServingModels.delete(baseModelId)
      },
      ui: this.#ui,
    })
    this.#terminal = new TerminalController(
      this.#renderer,
      () => this.#exiting,
      () => this.#ui.focusInput(),
    )
    this.#terminal.installRecovery()
    this.#installShutdownListeners()
    this.#startUpdateCheck()

    if (this.#configured) void this.#refreshLocalStats()
    if (models.selectedId && models.selectedProvider === "local") {
      const spec = findLocalModel(models.selectedId)
      if (spec) {
        const startupController = new AbortController()
        this.#startupModelController = startupController
        let prepared: PreparedModelSelection | undefined
        try {
          prepared = await this.#prepareSelectedModel(
            catalogModelFromSpec(spec, settings.modelContextLength),
            this.#app.fireworksApiKey,
            startupController.signal,
          )
          startupController.signal.throwIfAborted()
          prepared.commit()
          this.#configured = true
        } catch (error) {
          if (prepared) await prepared.rollback({ restorePrevious: false })
          if (startupController.signal.aborted || this.#exiting) return
          this.#configured = false
          this.#ui.showChatLayout()
          this.#app.transcript.addAssistantMessage(
            `Could not start ${spec.displayName}: ${error instanceof Error ? error.message : String(error)}`,
          )
          this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
        } finally {
          if (this.#startupModelController === startupController) this.#startupModelController = undefined
        }
      }
    }
    if (!this.#configured && this.#app.fireworksApiKey && models.selectedProvider !== "local") {
      this.#setupFlow.begin()
    }

    if (this.#app.transcript.entries.length > 0) {
      this.#ui.showChatLayout()
      this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
    }
  }

  #startUpdateCheck() {
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
        if (this.#updateCheckController === updateController) this.#updateCheckController = undefined
      })
  }

  async #handleInput(value: string) {
    if (!value && this.#images.pending.count === 0) return

    this.#ui.hideUpdateHint()

    const command = parseSlashCommand(value)
    if (command?.type === "queue") {
      if (!command.prompt) return
      if (this.#isBusy()) await this.#queuePrompt(createUserMessage(command.prompt))
      else await this.#runPromptTurn(command.prompt)
      await this.#drainPendingActions()
      return
    }

    if (this.#isBusy() && command && slashCommandRunsImmediately(command)) {
      await this.#runSlashCommand(command)
      return
    }

    if (this.#isBusy()) {
      if (command) {
        this.#ui.clearInput()
        this.#pendingActions.push({ type: "command", command })
        return
      }

      if (this.#app.conversation.busy) await this.#steerActiveTurn(createUserMessage(value))
      else await this.#queuePrompt(createUserMessage(value))
      return
    }

    if (command) {
      await this.#runSlashCommand(command)
      await this.#drainPendingActions()
      return
    }

    if (!this.#configured) {
      this.#setupFlow.begin()
      return
    }

    if (!this.#app.models.client) return

    await this.#runPromptTurn(value)
    await this.#drainPendingActions()
  }

  async #steerActiveTurn(message: UserChatMessage) {
    try {
      await this.#app.conversation.steer(message, () => {
        if (!this.#exiting) this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
      })
    } catch {
      this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
      return
    }
    this.#images.clear()
    this.#ui.clearInput()
    this.#updateContextIndicator()
    this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
  }

  async #queuePrompt(message: UserChatMessage) {
    if (!this.#configured || !this.#app.models.client) return

    try {
      await this.#app.conversation.queue(message)
      this.#images.clear()
      this.#ui.clearInput()
      this.#updateContextIndicator()
      this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
    } catch {
      this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
    }
  }

  async #selectModel(model: ModelPickerItem) {
    if (this.#isBusy()) {
      this.#ui.hideModelPicker()
      this.#pendingActions.push({ type: "model-selection", model })
      return
    }
    await this.#setupFlow.selectModel(model)
    await this.#drainPendingActions()
  }

  #startNewSession() {
    this.#images.clear()
    if (this.#isBusy()) {
      this.#ui.hideSessionPicker()
      this.#pendingActions.push({ type: "new-session" })
      return
    }
    this.#sessions.startNew()
  }

  async #selectSession(sessionId: string) {
    this.#images.clear()
    if (this.#isBusy()) {
      this.#ui.hideSessionPicker()
      this.#pendingActions.push({ type: "session-selection", sessionId })
      return
    }
    await this.#sessions.select(sessionId)
    await this.#drainPendingActions()
  }

  async #deleteSession(sessionId: string) {
    if (this.#isBusy()) {
      this.#pendingActions.push({ type: "session-deletion", sessionId })
      return
    }
    await this.#sessions.delete(sessionId)
    await this.#drainPendingActions()
  }

  async #drainPendingActions() {
    if (this.#drainingPendingActions || this.#isBusy() || this.#exiting) return
    this.#drainingPendingActions = true
    try {
      while (!this.#isBusy() && !this.#exiting) {
        const queued = this.#app.conversation.takeQueued()
        if (queued) {
          await this.#runPromptTurn("", queued)
          continue
        }
        const pending = this.#pendingActions.shift()
        if (!pending) return
        await this.#runPendingAction(pending)
      }
    } finally {
      this.#drainingPendingActions = false
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
        await this.#sessions.select(pending.sessionId)
        return
      case "session-deletion":
        await this.#sessions.delete(pending.sessionId)
        return
      case "new-session":
        this.#sessions.startNew()
    }
  }

  async #runSlashCommand(command: SlashCommand) {
    switch (command.type) {
      case "exit":
        await this.#quit()
        return
      case "theme-menu":
        this.#ui.clearInput()
        this.#ui.showThemeMenu()
        this.#ui.focusInput()
        return
      case "theme":
        await this.#selectThemeCommand(command.name)
        return
      case "model": {
        this.#ui.clearInput()
        await this.#setupFlow.openModelPicker(this.#app.fireworksApiKey, this.#app.models.selectedId, true, {
          background: this.#isBusy(),
        })
        return
      }
      case "settings": {
        this.#ui.clearInput()
        if (command.setting === "hosted") {
          this.#setupFlow.configureHostedInference()
        } else if (command.setting === "pair") {
          this.#setupFlow.configurePairInference()
        } else if (command.setting === "debug") {
          this.#toggleDebugMode()
        } else if (command.setting === "subagents") {
          await this.#setSubagentPanelVisible(!this.#subagentPanelVisible)
        } else if (command.setting === "delete-model") {
          if (command.modelId) this.#startLocalModelDeletion(command.modelId)
          else await this.#openLocalModelDeleteMenu()
        } else {
          this.#openSettingsMenu()
        }
        return
      }
      case "fast":
        await this.#toggleFastServing()
        return
      case "history":
        this.#ui.clearInput()
        await this.#sessions.openPicker()
        return
      case "new":
        this.#ui.clearInput()
        this.#images.clear()
        this.#sessions.startNew()
        return
      case "home":
        this.#ui.clearInput()
        this.#ui.showHomeLayout()
        void this.#refreshLocalStats()
        this.#ui.focusInput()
        return
      case "thinking":
        await this.#setThinkingVisible(!this.#thinkingVisible)
        return
      case "queue":
        return
      case "compact":
        this.#ui.clearInput()
        await this.#runCompaction(command.instructions)
        return
    }
  }

  async #runPromptTurn(value: string, queued?: QueuedPrompt) {
    if (!this.#app.models.client || !this.#app.models.selectedProvider) return

    const ready = queued ? undefined : this.#images.ensureReadyToSend(value)
    if (ready) {
      try {
        await ready
      } catch (error) {
        this.#images.showMessage(`Could not send images: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }

    this.#ui.setBusy(true)
    this.#ui.showChatLayout()
    const userMessage = queued?.admission.message ?? createUserMessage(value, this.#images.pending.items)

    try {
      const result = await this.#app.conversation.start(queued ?? userMessage, {
        ...this.#conversationHooks(),
        onReady: (message) => {
          if (this.#app.transcript.history.length === 1) {
            this.#sessions.setProvisionalLabel(value || summarizeUserMessage(message))
          }
          this.#images.clear()
          this.#updateContextIndicator()
          this.#ui.clearInput()
          this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
        },
      })
      if (!this.#exiting) this.#ui.renderTranscript(this.#app.transcript.entries)
      if (result.status === "interrupted" || result.status === "error") {
        if (!this.#exiting) this.#updateContextIndicator()
        return
      }
      if (result.status !== "complete") {
        if (!this.#exiting && result.status !== "incomplete") this.#updateContextIndicator()
        return
      }
      this.#sessions.refreshLabel()
      this.#updateContextIndicator()
      const turnSession = this.#app.sessions.current
      if (turnSession && !turnSession.hasTitle()) void this.#sessions.generateTitle(turnSession)
    } finally {
      this.#ui.setBusy(false)
      if (!this.#exiting) {
        this.#ui.stopBusyIndicator()
        this.#ui.focusInput()
      }
    }
  }

  async #runCompaction(instructions?: string) {
    if (this.#isBusy() || !this.#app.models.client) return

    this.#ui.setBusy(true)
    this.#ui.showChatLayout()
    this.#ui.startBusyIndicator()
    try {
      await this.#app.conversation.compact(instructions, this.#app.contextEstimator(), () => {
        this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
      })
      this.#ui.renderSubagents(this.#app.subagents.all)
      this.#sessions.refreshLabel()
      this.#updateContextIndicator()
      this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
    } finally {
      this.#ui.setBusy(false)
      this.#ui.stopBusyIndicator()
      if (!this.#exiting) this.#ui.focusInput()
    }
  }

  #installShutdownListeners() {
    const onSignal = () => {
      void this.#quit()
    }
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
    this.#removeShutdownListeners = () => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      this.#removeShutdownListeners = undefined
    }
  }

  #quit() {
    if (this.#quitPromise) return this.#quitPromise
    this.#quitPromise = this.#runQuit()
    return this.#quitPromise
  }

  async #runQuit() {
    this.#exiting = true
    this.#removeShutdownListeners?.()
    this.#updateCheckController?.abort()
    this.#startupModelController?.abort()
    this.#ui.hidePermissionPrompt()
    try {
      await this.#setupFlow.shutdown()
      await this.#localModelManagementTask?.catch(() => undefined)
      await this.#app.shutdown()
    } finally {
      this.#renderer.destroy()
    }
  }

  async #refreshLocalStats() {
    try {
      const stats = await calculateLocalStats()
      if (!this.#exiting) this.#ui.setStats(stats)
    } catch {
      // A damaged or temporarily unavailable local stats file must not block the CLI.
    }
  }

  async #openLocalModelDeleteMenu() {
    const models = await listDownloadedLocalModels()
    this.#setDownloadedModelsAvailable(models.length > 0)
    if (models.length === 0) {
      this.#ui.showTransientHint(" No downloaded local models. ")
      this.#ui.focusInput()
      return
    }
    this.#showLocalModelDeleteMenu(models)
  }

  #openSettingsMenu() {
    const items = [
      {
        name: "Hosted inference",
        description: this.#app.fireworksApiKey ? "Replace API key" : "Add API key",
        submission: "/settings hosted",
      },
      {
        name: "NVIDIA PAIR",
        description:
          this.#app.pairEndpoints.ollama || this.#app.pairEndpoints.lmStudio
            ? "Reconnect or choose model"
            : "Connect local AI cluster",
        submission: "/settings pair",
      },
      ...(this.#downloadedModelsAvailable
        ? [
            {
              name: "Delete local model",
              description: "Choose a downloaded model",
              submission: "/settings delete-model",
            },
          ]
        : []),
      {
        name: "Debug mode",
        description: this.#debug ? "On" : "Off",
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

  #toggleDebugMode() {
    this.#debug = !this.#debug
    this.#ui.showTransientHint(` Debug mode ${this.#debug ? "on" : "off"} `)
    this.#ui.focusInput()
  }

  #showLocalModelDeleteMenu(models: readonly LocalModelSpec[]) {
    this.#ui.showCommandSubmenu(
      models.map((model) => ({
        name: model.displayName,
        description: `${this.#app.models.selectedProvider === "local" && model.id === this.#app.models.selectedId ? "Active · " : ""}${model.quant} · ${formatMemoryLabel(localModelWeightBytes(model))}`,
        submission: `/settings delete-model ${model.id}`,
      })),
      { onBack: () => this.#openSettingsMenu() },
    )
    this.#ui.focusInput()
  }

  #startLocalModelDeletion(modelId: string) {
    if (this.#localModelManagementTask) return
    const task = this.#deleteLocalModel(modelId)
    this.#localModelManagementTask = task
    void task.then(
      () => {
        if (this.#localModelManagementTask === task) this.#localModelManagementTask = undefined
      },
      (error) => {
        if (this.#localModelManagementTask === task) this.#localModelManagementTask = undefined
        if (!this.#exiting) this.#ui.showTransientHint(` Could not manage local models: ${errorMessage(error)} `)
      },
    )
  }

  async #deleteLocalModel(modelId: string) {
    if (this.#exiting || this.#isBusy()) return
    const spec = findLocalModel(modelId)
    if (!spec) return

    this.#busy = true
    this.#ui.setBusy(true)
    let active = false
    let settingsCleared = false
    let previousActive = this.#app.models.activeLocal
    let previousModel = catalogModelFromSpec(spec, previousActive?.contextLength)
    let remaining: LocalModelSpec[] = []

    try {
      await this.#setupFlow.cancelModelSelection()
      active = this.#app.models.selectedProvider === "local" && this.#app.models.selectedId === spec.id
      previousActive = this.#app.models.activeLocal
      previousModel = catalogModelFromSpec(spec, previousActive?.contextLength)
      const downloaded = await listDownloadedLocalModels()
      const deletingLast = downloaded.length === 1 && downloaded[0]?.id === spec.id

      if (active) {
        await clearSelectedModel()
        settingsCleared = true
      }
      if (active || deletingLast) await this.#app.models.llama.stop()
      await deleteLocalGguf(spec)
      remaining = await listDownloadedLocalModels()
    } catch (error) {
      let failure = error
      if (active && settingsCleared) {
        try {
          await saveSelectedModel(previousModel)
          if (previousActive) await this.#app.models.restorePrevious(previousActive)
        } catch (rollbackError) {
          failure = new AggregateError(
            [error, rollbackError],
            `${errorMessage(error)} The active local model could not be restored.`,
          )
        }
      }
      if (!this.#exiting) {
        this.#ui.showTransientHint(` Could not delete ${spec.displayName}: ${errorMessage(failure)} `)
        this.#ui.focusInput()
      }
      return
    } finally {
      this.#busy = false
      if (!this.#exiting) this.#ui.setBusy(false)
    }

    this.#setDownloadedModelsAvailable(remaining.length > 0)
    if (active) {
      this.#app.models.cancelPrepare()
      this.#app.models.activeLocal = undefined
      this.#app.models.selectedId = undefined
      this.#app.models.selectedProvider = undefined
      this.#app.models.client = undefined
      this.#configured = false
      this.#images.setModelCapability(false)
      this.#app.models.autoCompactAtTokens = autoCompactThreshold()
      this.#setupFlow.forgetSelectedModel(spec.id)
      if (this.#exiting) return
      this.#ui.setModelLabel("No model")
      this.#setFastAvailable(false)
      this.#updateContextIndicator()
      await this.#setupFlow.openModelPicker(this.#app.fireworksApiKey, undefined, true)
      if (!this.#exiting) this.#ui.showTransientHint(` Deleted ${spec.displayName}. Choose another model. `)
      return
    }

    if (this.#exiting) return
    if (remaining.length > 0) this.#showLocalModelDeleteMenu(remaining)
    else {
      this.#ui.showTransientHint(` Deleted ${spec.displayName}. `)
      this.#ui.focusInput()
    }
  }

  async #prepareSelectedModel(
    model: CatalogModel,
    fireworksApiKey: string | undefined,
    signal: AbortSignal,
  ): Promise<PreparedModelSelection> {
    if (this.#localLoadStatus && this.#localLoadStatus.modelId !== model.id) {
      this.#ui.setModelPickerStatus(this.#localLoadStatus.modelId, undefined)
      this.#localLoadStatus = undefined
    }
    try {
      const prepared = await this.#app.models.prepare(model, {
        fireworksApiKey,
        signal,
        isExiting: () => this.#exiting,
        onLocalProgress: (progress) => {
          const status: ModelPickerStatus = { label: formatLocalLoadStatus(progress), kind: "progress" }
          this.#localLoadStatus = { modelId: model.id, status }
          this.#ui.setModelPickerStatus(model.id, status)
        },
      })
      if (isLocalCatalogModel(prepared.model)) this.#setDownloadedModelsAvailable(true)
      return {
        model: prepared.model,
        commit: () => {
          prepared.commit()
          this.#syncActivatedModel(prepared.model)
          this.#clearLocalLoadStatus(prepared.model.id)
        },
        rollback: async (options) => {
          this.#clearLocalLoadStatus(prepared.model.id)
          await prepared.rollback(options)
        },
      }
    } catch (error) {
      this.#clearLocalLoadStatus(model.id)
      if (isLocalCatalogModel(model)) await this.#refreshDownloadedModelAvailability()
      throw error
    }
  }

  #syncActivatedModel(model: CatalogModel) {
    this.#images.setModelCapability(this.#app.models.supportsImageInput)
    this.#configured = true
    if (this.#exiting) return
    this.#ui.setModelLabel(this.#formatModelLabel(model))
    this.#setFastAvailable(model.provider === "fireworks" && (Boolean(model.fastId) || isFastFireworksModel(model.id)))
    this.#updateContextIndicator()
  }

  #formatModelLabel(model: CatalogModel) {
    if (model.provider === "pair") return `${formatModelName(model.displayName)} · NVIDIA PAIR`
    if (model.provider === "local") return `${formatModelName(model.displayName)} · Local`
    return withFastModelMark(formatModelName(model.displayName), isFastFireworksModel(model.id))
  }

  #clearLocalLoadStatus(modelId: string) {
    if (this.#localLoadStatus?.modelId === modelId) this.#localLoadStatus = undefined
    if (!this.#exiting) this.#ui.setModelPickerStatus(modelId, undefined)
  }

  #setFastAvailable(available: boolean) {
    this.#fastAvailable = available
    if (!this.#exiting) this.#refreshCommands()
  }

  #setDownloadedModelsAvailable(available: boolean) {
    this.#downloadedModelsAvailable = available
  }

  async #refreshDownloadedModelAvailability() {
    const available = (await listDownloadedLocalModels()).length > 0
    if (!this.#exiting) this.#setDownloadedModelsAvailable(available)
  }

  #refreshCommands() {
    this.#ui.setCommands(slashCommands({ fast: this.#fastAvailable }))
  }

  #isBusy() {
    return this.#busy || this.#app.conversation.busy
  }

  #conversationHooks(): ConversationHooks {
    return {
      sink: this.#conversationSink(),
      debug: this.#debug,
      onContext: (tokens) => {
        const usage = contextUsage(tokens, this.#app.models.autoCompactAtTokens)
        this.#ui.setContextLabel(formatContextUsage(usage), contextUsageColor(usage.percent))
      },
      onDiff: (added, removed) => {
        this.#sessions.addDiff(added, removed)
      },
      onPermissionRequest: (request) => this.#handlePermissionRequest(request),
      onCompletion: () => this.#terminal.notifyCompletion(),
    }
  }

  async #persistSelection(model: CatalogModel, options: PersistSelectionOptions) {
    if (this.#localLoadStatus && this.#localLoadStatus.modelId !== model.id) {
      this.#ui.setModelPickerStatus(this.#localLoadStatus.modelId, undefined)
      this.#localLoadStatus = undefined
    }
    try {
      const activated = await this.#app.models.persistSelection(model, {
        ...options,
        isExiting: () => this.#exiting,
        onLocalProgress: (progress) => {
          const status: ModelPickerStatus = { label: formatLocalLoadStatus(progress), kind: "progress" }
          this.#localLoadStatus = { modelId: model.id, status }
          this.#ui.setModelPickerStatus(model.id, status)
        },
        wrap: (prepared) => ({
          model: prepared.model,
          commit: () => {
            prepared.commit()
            this.#syncActivatedModel(prepared.model)
            this.#clearLocalLoadStatus(prepared.model.id)
          },
          rollback: async (rollback) => {
            this.#clearLocalLoadStatus(prepared.model.id)
            await prepared.rollback(rollback)
          },
        }),
      })
      if (isLocalCatalogModel(activated)) this.#setDownloadedModelsAvailable(true)
      return activated
    } catch (error) {
      this.#clearLocalLoadStatus(model.id)
      if (isLocalCatalogModel(model)) await this.#refreshDownloadedModelAvailability()
      throw error
    }
  }

  #conversationSink(): ConversationSink {
    return {
      renderTranscript: (options) => this.#ui.renderTranscript(this.#app.transcript.entries, options),
      renderSubagents: () => this.#ui.renderSubagents(this.#app.subagents.all),
      setPhase: (phase) => this.#ui.setAgentPhase(phase),
      startBusy: () => this.#ui.startBusyIndicator(),
      stopBusy: () => this.#ui.stopBusyIndicator(),
    }
  }

  #updateContextIndicator(pendingInput = "") {
    const pendingMessage = createUserMessage(pendingInput, this.#images.pending.items)
    const usage = contextUsage(
      this.#app.contextEstimator()([
        ...this.#app.transcript.history,
        ...(pendingInput || this.#images.pending.items.length > 0 ? [pendingMessage] : []),
      ]),
      this.#app.models.autoCompactAtTokens,
    )
    this.#ui.setContextLabel(formatContextUsage(usage), contextUsageColor(usage.percent))
  }

  #toggleMode() {
    this.#app.permissionMode = this.#app.permissionMode === "ask" ? "auto" : "ask"
    this.#ui.setModeLabel(formatModeLabel(this.#app.permissionMode))
  }

  async #selectThemeCommand(value: string) {
    if (!isThemeName(value)) {
      this.#showThemeMessage("Choose a theme with `/theme`.")
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
      this.#showThemeMessage(`Could not save theme: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #previewTheme(theme: ThemeName) {
    const previous = selectTheme(theme)
    this.#ui.setTheme(theme, previous)
  }

  async #toggleFastServing() {
    if (!this.#configured || !this.#app.fireworksApiKey || !this.#app.models.selectedId) {
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

  async #setSubagentPanelVisible(visible: boolean) {
    const previous = this.#subagentPanelVisible
    this.#subagentPanelVisible = visible
    this.#ui.setSubagentPanelVisible(visible)
    this.#ui.clearInput()
    this.#ui.focusInput()
    try {
      await saveSubagentPanelVisible(visible)
      this.#ui.showTransientHint(` Subagents ${visible ? "shown" : "hidden"} `)
    } catch (error) {
      this.#subagentPanelVisible = previous
      this.#ui.setSubagentPanelVisible(previous)
      this.#app.transcript.addDebugMessage(
        `Could not save subagent panel visibility: ${error instanceof Error ? error.message : String(error)}`,
      )
      this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
    }
  }

  async #setThinkingVisible(visible: boolean) {
    const previous = this.#thinkingVisible
    this.#thinkingVisible = visible
    this.#ui.setThinkingVisible(visible)
    this.#ui.clearInput()
    this.#ui.focusInput()
    try {
      await saveThinkingVisible(visible)
      this.#ui.showTransientHint(` Thinking traces ${visible ? "shown" : "hidden"} `)
    } catch (error) {
      this.#thinkingVisible = previous
      this.#ui.setThinkingVisible(previous)
      this.#app.transcript.addDebugMessage(
        `Could not save thinking visibility: ${error instanceof Error ? error.message : String(error)}`,
      )
      this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
    }
  }

  #showThemeMessage(message: string) {
    this.#ui.showChatLayout()
    this.#app.transcript.addAssistantMessage(message)
    this.#ui.clearInput()
    this.#ui.renderTranscript(this.#app.transcript.entries)
    this.#ui.focusInput()
  }

  #handlePermissionRequest(request: PermissionRequest): Promise<boolean> {
    const activity = describeToolCall(request.call)
    return this.#ui.showPermissionPrompt(activity.label)
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
