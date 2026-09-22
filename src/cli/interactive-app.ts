import { createCliRenderer, getTreeSitterClient, type TreeSitterClient } from "@opentui/core"
import { Application, formatWorkspaceLabel } from "../app/application.js"
import type { QueuedPrompt } from "../app/conversation.js"
import type { PersistSelectionOptions } from "../app/models.js"
import { autoCompactThreshold } from "../core/compaction.js"
import { FireworksClient } from "../inference/client.js"
import { deleteLocalGguf, listDownloadedLocalModels } from "../inference/gguf-cache.js"
import {
  supportsLlamaCppTarget,
  unsupportedLlamaCppTargetMessage,
} from "../inference/llama-binary.js"
import { formatLocalLoadStatus, type LocalLoadProgress } from "../inference/llama-runtime.js"
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
import {
  type CatalogModel,
  isLocalCatalogModel,
  type ModelProvider,
  type UserChatMessage,
} from "../inference/types.js"
import {
  clearSelectedModel,
  isThemeName,
  saveSelectedModel,
  saveSelectedTheme,
  saveSubagentPanelVisible,
  saveThinkingVisible,
  THEME_NAMES,
  type ThemeName,
} from "../local/settings.js"
import { calculateLocalStats } from "../local/stats.js"
import { describeToolCall } from "../tools/index.js"
import { AttachmentFlow } from "./attachment-flow.js"
import { createChatUI } from "./chat-ui.js"
import { SetupFlow } from "./setup-flow.js"
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
  #terminal!: TerminalController
  #busy = false
  #debug = false
  #exiting = false
  #quitPromise: Promise<void> | undefined
  #localModelManagementTask: Promise<void> | undefined
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
  #removeShutdownListeners: (() => void) | undefined

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
    this.#attachments = new AttachmentFlow({
      cwd: this.#app.cwd,
      isBusy: () => this.#isBusy(),
      apiKey: () => this.#app.fireworksApiKey,
      selectedModelId: () => this.#app.models.selectedId,
      ui: () => this.#ui,
      transcript: this.#app.transcript,
      onContextChange: () => this.#updateContextIndicator(),
    })
    this.#attachments.setModelCapability(models.supportsImageInput)

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

    this.#ui = createChatUI(this.#renderer, {
      configured: this.#configured,
      localInferenceUnavailableReason,
      commands: slashCommands({ fast: this.#fastAvailable }),
      contextLabel: formatContextUsage(
        contextUsage(
          this.#app.contextEstimator()(this.#app.transcript.history),
          models.autoCompactAtTokens,
        ),
      ),
      modelLabel: modelLabel(
        models.selectedProvider,
        settings.modelDisplayName ?? models.selectedId,
        models.selectedId ?? "",
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
        this.#app.permissionMode = this.#app.permissionMode === "ask" ? "auto" : "ask"
        this.#ui.setModeLabel(formatModeLabel(this.#app.permissionMode))
      },
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
        if (
          credentials.fireworksApiKey &&
          models.selectedId &&
          models.selectedProvider === "fireworks"
        ) {
          models.client = new FireworksClient({
            apiKey: credentials.fireworksApiKey,
            model: models.selectedId,
          })
        }
        this.#ui.showStats()
        void this.#refreshLocalStats()
      },
      connectLocalServers: async (inputs, signal) => {
        const connection = await this.#app.connectLocalServers(inputs, { signal })
        this.#attachments.setModelCapability(this.#app.models.supportsImageInput)
        this.#updateContextIndicator()
        return connection
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
    if (models.selectedId && models.selectedProvider === "omlx") {
      const controller = new AbortController()
      this.#startupModelController = controller
      this.#busy = true
      this.#ui.setBusy(true)
      try {
        await this.#app.startSavedSelection({ signal: controller.signal })
        this.#attachments.setModelCapability(models.supportsImageInput)
        this.#updateContextIndicator()
      } catch (error) {
        if (controller.signal.aborted || this.#exiting) return
        this.#configured = false
        this.#app.transcript.addAssistantMessage(
          `Could not connect to oMLX: ${errorMessage(error)}`,
        )
      } finally {
        this.#busy = false
        this.#ui.setBusy(false)
        if (this.#startupModelController === controller) this.#startupModelController = undefined
      }
      if (!this.#configured) this.#setupFlow.begin()
    }
    const spec =
      models.selectedProvider === "local" && models.selectedId
        ? findLocalModel(models.selectedId)
        : undefined
    if (spec) {
      const startupController = new AbortController()
      this.#startupModelController = startupController
      const model = catalogModelFromSpec(spec, settings.modelContextLength)
      try {
        await this.#app.startSavedSelection({
          signal: startupController.signal,
          isExiting: () => this.#exiting,
          onLocalProgress: (progress) => this.#showLocalLoadProgress(model.id, progress),
        })
        this.#downloadedModelsAvailable = true
        this.#syncActivatedModel(model)
        this.#clearLocalLoadStatus(model.id)
      } catch (error) {
        this.#clearLocalLoadStatus(model.id)
        await this.#refreshDownloadedModelAvailability()
        if (startupController.signal.aborted || this.#exiting) return
        this.#configured = false
        this.#ui.showChatLayout()
        this.#app.transcript.addAssistantMessage(
          `Could not start ${spec.displayName}: ${errorMessage(error)}`,
        )
        this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
      } finally {
        if (this.#startupModelController === startupController)
          this.#startupModelController = undefined
      }
    }
    if (
      !this.#configured &&
      this.#app.fireworksApiKey &&
      models.selectedProvider !== "local" &&
      models.selectedProvider !== "omlx"
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
      if (!command.prompt) return
      if (this.#isBusy()) await this.#queuePrompt(createUserMessage(command.prompt))
      else await this.#runPromptTurn(command.prompt)
      await this.#drainPendingActions()
      return
    }

    if (this.#isBusy()) {
      if (command && slashCommandRunsImmediately(command)) {
        await this.#runSlashCommand(command)
        return
      }
      if (command) {
        this.#ui.clearInput()
        this.#pendingActions.push({ type: "command", command })
        return
      }
      const message = createUserMessage(value)
      if (!this.#app.conversation.busy) {
        await this.#queuePrompt(message)
        return
      }
      try {
        await this.#app.conversation.steer(message, () => {
          if (!this.#exiting)
            this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
        })
        this.#attachments.clear()
        this.#ui.clearInput()
        this.#updateContextIndicator()
      } catch {
        // The conversation already recorded the failure in the transcript.
      }
      this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
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

  async #queuePrompt(message: UserChatMessage) {
    if (!this.#configured || !this.#app.models.client) return

    try {
      await this.#app.conversation.queue(message)
      this.#attachments.clear()
      this.#ui.clearInput()
      this.#updateContextIndicator()
    } catch {
      // The conversation already recorded the failure in the transcript.
    }
    this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
  }

  async #runOrDefer(pending: PendingAction, hidePicker?: () => void) {
    if (this.#isBusy()) {
      hidePicker?.()
      this.#pendingActions.push(pending)
      return
    }
    await this.#runPendingAction(pending)
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
        await this.#setupFlow.openModelPicker(
          this.#app.fireworksApiKey,
          this.#app.models.selectedId,
          true,
          {
            background: this.#isBusy(),
          },
        )
        return
      }
      case "settings": {
        this.#ui.clearInput()
        if (command.setting === "hosted") {
          this.#setupFlow.configureHostedInference()
        } else if (command.setting === "pair" || command.setting === "servers") {
          this.#setupFlow.configurePairInference()
        } else if (command.setting === "debug") {
          this.#debug = !this.#debug
          this.#ui.showTransientHint(` Debug mode ${this.#debug ? "on" : "off"} `)
          this.#ui.focusInput()
        } else if (command.setting === "subagents") {
          await this.#setPanelVisible("subagents", !this.#subagentPanelVisible)
        } else if (command.setting === "theme") {
          this.#openThemeMenu()
        } else if (command.setting === "delete-model") {
          if (command.modelId) {
            this.#startLocalModelDeletion(command.modelId)
            return
          }
          const models = await listDownloadedLocalModels()
          this.#downloadedModelsAvailable = models.length > 0
          if (models.length === 0) {
            this.#ui.showTransientHint(" No downloaded local models. ")
            this.#ui.focusInput()
            return
          }
          this.#showLocalModelDeleteMenu(models)
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
        try {
          this.#ui.showSessionPicker(await this.#app.sessions.listPickerItems())
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
      case "effort": {
        const state = this.#app.models.thinkingState()
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
          this.#ui.showTransientHint(` ${errorMessage(error)} `)
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

  async #runPromptTurn(value: string, queued?: QueuedPrompt) {
    if (!this.#app.models.client || !this.#app.models.selectedProvider) return

    const ready = queued ? undefined : this.#attachments.ensureReadyToSend(value)
    if (ready) {
      try {
        await ready
      } catch (error) {
        this.#attachments.showMessage(`Could not send attachments: ${errorMessage(error)}`)
        return
      }
    }

    this.#ui.setBusy(true)
    this.#ui.showChatLayout()
    const userMessage =
      queued?.admission.message ?? createUserMessage(value, this.#attachments.pending.items)

    try {
      const result = await this.#app.conversation.start(queued ?? userMessage, {
        sink: {
          renderTranscript: (options) =>
            this.#ui.renderTranscript(this.#app.transcript.entries, options),
          renderSubagents: () => this.#ui.renderSubagents(this.#app.subagents.all),
          setPhase: (phase) => this.#ui.setAgentPhase(phase),
          startBusy: () => this.#ui.startBusyIndicator(),
          stopBusy: () => this.#ui.stopBusyIndicator(),
        },
        debug: this.#debug,
        onContext: (tokens) => {
          const usage = contextUsage(tokens, this.#app.models.autoCompactAtTokens)
          this.#ui.setContextLabel(formatContextUsage(usage), contextUsageColor(usage.percent))
        },
        onDiff: (added, removed) => {
          const diffs = this.#app.sessions.addDiff(added, removed)
          this.#ui.setDiffStats(diffs.added, diffs.removed)
        },
        onPermissionRequest: (request) =>
          this.#ui.showPermissionPrompt(describeToolCall(request.call).label),
        onCompletion: () => this.#terminal.notifyCompletion(),
        onReady: (message) => {
          if (this.#app.transcript.history.length === 1) {
            this.#ui.setSessionLabel(
              this.#app.sessions.provisionalLabel(value || summarizeUserMessage(message)),
            )
          }
          this.#attachments.clear()
          this.#updateContextIndicator()
          this.#ui.clearInput()
          this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
        },
      })
      if (this.#exiting) return
      this.#ui.renderTranscript(this.#app.transcript.entries)
      if (result.status === "incomplete") return
      if (result.status !== "complete") {
        this.#updateContextIndicator()
        return
      }
      this.#refreshSessionLabel()
      this.#updateContextIndicator()
      const turnSession = this.#app.sessions.current
      if (turnSession && !turnSession.hasTitle()) {
        void this.#app.sessions
          .generateTitle(turnSession)
          .then((title) => {
            if (title) this.#ui.setSessionLabel(title)
          })
          .catch(() => {
            // Title generation is best-effort; the first user message remains as the label.
          })
      }
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
      this.#refreshSessionLabel()
      this.#updateContextIndicator()
      this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
    } finally {
      this.#ui.setBusy(false)
      this.#ui.stopBusyIndicator()
      if (!this.#exiting) this.#ui.focusInput()
    }
  }

  #quit() {
    this.#quitPromise ??= (async () => {
      this.#exiting = true
      this.#removeShutdownListeners?.()
      this.#removeShutdownListeners = undefined
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

  async #selectSession(sessionId: string) {
    try {
      const result = await this.#app.sessions.select(sessionId)
      if (result === "locked") {
        this.#reportSessionError(
          "Could not open session",
          new Error("It is open in another Otis window."),
        )
      } else if (result === "loaded") {
        this.#reflectSession()
      } else {
        this.#ui.focusInput()
      }
    } catch (error) {
      this.#reportSessionError("Could not open session", error)
    }
  }

  async #deleteSession(sessionId: string) {
    const wasCurrent = this.#app.sessions.current?.id === sessionId
    try {
      const result = await this.#app.sessions.delete(sessionId)
      if (result === "locked") {
        this.#reportSessionError(
          "Could not delete session",
          new Error("It is open in another Otis window."),
        )
      } else if (result === "deleted" && wasCurrent) {
        this.#reflectSession()
      }
    } catch (error) {
      this.#reportSessionError("Could not delete session", error)
    }
    try {
      this.#ui.showSessionPicker(await this.#app.sessions.listPickerItems())
    } catch {
      // Keep the current picker state if disk re-sync fails after the primary action.
    }
  }

  #startNewSession() {
    if (!this.#app.sessions.startNew()) return
    this.#ui.hideSessionPicker()
    this.#reflectSession()
    this.#ui.focusInput()
  }

  #refreshSessionLabel() {
    this.#ui.setSessionLabel(this.#app.sessions.activeLabel())
  }

  #reflectSession() {
    const sessions = this.#app.sessions
    const ui = this.#ui
    ui.setDiffStats(sessions.diffs.added, sessions.diffs.removed)
    this.#refreshSessionLabel()
    ui.showChatLayout()
    ui.renderTranscript(sessions.transcript.entries, { scrollToBottom: true })
    ui.renderSubagents(sessions.subagents.all)
    this.#updateContextIndicator()
    ui.focusInput()
  }

  #reportSessionError(prefix: string, error: unknown) {
    this.#ui.showChatLayout()
    this.#app.transcript.addAssistantMessage(`Error: ${prefix}: ${errorMessage(error)}`)
    this.#ui.renderTranscript(this.#app.transcript.entries, { scrollToBottom: true })
    this.#ui.focusInput()
  }

  #openSettingsMenu() {
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
        name: "Theme",
        description: this.#selectedTheme,
        submission: "/settings theme",
      },
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

  #openThemeMenu() {
    this.#ui.clearInput()
    this.#ui.showCommandSubmenu(
      THEME_NAMES.map((theme) => ({
        name: theme,
        description: theme === this.#selectedTheme ? "Active" : "",
        submission: `/settings theme ${theme}`,
      })),
      { onBack: () => this.#openSettingsMenu() },
    )
    this.#ui.focusInput()
  }

  #showLocalModelDeleteMenu(models: readonly LocalModelSpec[]) {
    const { selectedProvider, selectedId } = this.#app.models
    this.#ui.showCommandSubmenu(
      models.map((model) => {
        const active = selectedProvider === "local" && model.id === selectedId ? "Active · " : ""
        const size = formatMemoryLabel(localModelWeightBytes(model))
        return {
          name: model.displayName,
          description: `${active}${model.quant} · ${size}`,
          submission: `/settings delete-model ${model.id}`,
        }
      }),
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
        if (!this.#exiting)
          this.#ui.showTransientHint(` Could not manage local models: ${errorMessage(error)} `)
      },
    )
  }

  async #deleteLocalModel(modelId: string) {
    if (this.#exiting || this.#isBusy()) return
    const spec = findLocalModel(modelId)
    if (!spec) return

    const models = this.#app.models
    this.#busy = true
    this.#ui.setBusy(true)
    await this.#setupFlow.cancelModelSelection()
    const active = models.selectedProvider === "local" && models.selectedId === spec.id
    const previousActive = models.activeLocal
    let settingsCleared = false
    let remaining: LocalModelSpec[] = []

    try {
      const downloaded = await listDownloadedLocalModels()
      const deletingLast = downloaded.length === 1 && downloaded[0]?.id === spec.id

      if (active) {
        await clearSelectedModel()
        settingsCleared = true
      }
      if (active || deletingLast) await models.llama.stop()
      await deleteLocalGguf(spec)
      remaining = await listDownloadedLocalModels()
    } catch (error) {
      let failure = error
      if (settingsCleared) {
        try {
          await saveSelectedModel(catalogModelFromSpec(spec, previousActive?.contextLength))
          if (previousActive) await models.restorePrevious(previousActive)
        } catch (rollbackError) {
          failure = new AggregateError(
            [error, rollbackError],
            `${errorMessage(error)} The active local model could not be restored.`,
          )
        }
      }
      if (!this.#exiting) {
        this.#ui.showTransientHint(
          ` Could not delete ${spec.displayName}: ${errorMessage(failure)} `,
        )
        this.#ui.focusInput()
      }
      return
    } finally {
      this.#busy = false
      if (!this.#exiting) this.#ui.setBusy(false)
    }

    this.#downloadedModelsAvailable = remaining.length > 0
    if (active) {
      models.cancelPrepare()
      models.activeLocal = undefined
      models.selectedId = undefined
      models.selectedProvider = undefined
      models.client = undefined
      this.#configured = false
      this.#attachments.setModelCapability(false)
      models.autoCompactAtTokens = autoCompactThreshold()
      this.#setupFlow.forgetSelectedModel(spec.id)
      if (this.#exiting) return
      this.#ui.setModelLabel("No model")
      this.#setFastAvailable(false)
      this.#updateContextIndicator()
      await this.#setupFlow.openModelPicker(this.#app.fireworksApiKey, undefined, true)
      if (!this.#exiting)
        this.#ui.showTransientHint(` Deleted ${spec.displayName}. Choose another model. `)
      return
    }

    if (this.#exiting) return
    if (remaining.length > 0) this.#showLocalModelDeleteMenu(remaining)
    else {
      this.#ui.showTransientHint(` Deleted ${spec.displayName}. `)
      this.#ui.focusInput()
    }
  }

  #showLocalLoadProgress(modelId: string, progress: LocalLoadProgress) {
    const status: ModelPickerStatus = { label: formatLocalLoadStatus(progress), kind: "progress" }
    this.#localLoadStatus = { modelId, status }
    this.#ui.setModelPickerStatus(modelId, status)
  }

  #syncActivatedModel(model: CatalogModel) {
    this.#attachments.setModelCapability(this.#app.models.supportsImageInput)
    this.#configured = true
    if (this.#exiting) return
    this.#ui.setModelLabel(modelLabel(model.provider, model.displayName, model.id))
    this.#setFastAvailable(
      model.provider === "fireworks" && (Boolean(model.fastId) || isFastFireworksModel(model.id)),
    )
    this.#updateContextIndicator()
  }

  #clearLocalLoadStatus(modelId: string) {
    if (this.#localLoadStatus?.modelId === modelId) this.#localLoadStatus = undefined
    if (!this.#exiting) this.#ui.setModelPickerStatus(modelId, undefined)
  }

  #setFastAvailable(available: boolean) {
    this.#fastAvailable = available
    if (!this.#exiting) this.#ui.setCommands(slashCommands({ fast: available }))
  }

  async #refreshDownloadedModelAvailability() {
    const available = (await listDownloadedLocalModels()).length > 0
    if (!this.#exiting) this.#downloadedModelsAvailable = available
  }

  #isBusy() {
    return this.#busy || this.#app.conversation.busy
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
        onLocalProgress: (progress) => this.#showLocalLoadProgress(model.id, progress),
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
      if (isLocalCatalogModel(activated)) this.#downloadedModelsAvailable = true
      return activated
    } catch (error) {
      this.#clearLocalLoadStatus(model.id)
      if (isLocalCatalogModel(model)) await this.#refreshDownloadedModelAvailability()
      throw error
    }
  }

  #updateContextIndicator(pendingInput = "") {
    const pendingMessage = createUserMessage(pendingInput, this.#attachments.pending.items)
    const usage = contextUsage(
      this.#app.contextTokens(
        pendingInput || this.#attachments.pending.items.length > 0 ? pendingMessage : undefined,
      ),
      this.#app.models.autoCompactAtTokens,
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
      this.#showThemeMessage(`Could not save theme: ${errorMessage(error)}`)
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
      this.#app.transcript.addDebugMessage(`Could not save ${label}: ${errorMessage(error)}`)
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
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
