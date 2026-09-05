import { createCliRenderer } from "@opentui/core"
import { autoCompactThreshold, compactConversation } from "../core/compaction.js"
import { loadProjectContext } from "../core/context.js"
import { requestContextEstimator } from "../core/context-tokens.js"
import { SteeringInbox } from "../core/steering.js"
import { providerTools } from "../core/subagent.js"
import { FireworksClient } from "../inference/client.js"
import { compactionContextLength } from "../inference/context-policy.js"
import { deleteLocalGguf, listDownloadedLocalModels } from "../inference/gguf-cache.js"
import { detectHardware, type HardwareProbe } from "../inference/hardware.js"
import { supportsLlamaCppTarget, unsupportedLlamaCppTargetMessage } from "../inference/llama-binary.js"
import { LlamaCppRuntime, type LocalServingEndpoint } from "../inference/llama-runtime.js"
import {
  catalogModelFromSpec,
  findLocalModel,
  isLocalModelId,
  type LocalModelSpec,
  localModelWeightBytes,
} from "../inference/local-catalog.js"
import { LlamaCppClient } from "../inference/local-client.js"
import { fitLocalModel, formatMemoryLabel, type LocalModelFit } from "../inference/local-fit.js"
import { createUserMessage, summarizeUserMessage } from "../inference/messages.js"
import { PairClient, type PairEndpoints, pairEndpointForEngine } from "../inference/pair.js"
import type { ModelPickerItem, ModelPickerStatus } from "../inference/picker-catalog.js"
import { baseFireworksModelId, isFastFireworksModel } from "../inference/serving-path.js"
import {
  type CatalogModel,
  type ContextFile,
  type InferenceClient,
  isLocalCatalogModel,
  isPairCatalogModel,
  type ModelProvider,
  type PairEngine,
  type UserChatMessage,
} from "../inference/types.js"
import {
  clearSelectedModel,
  isThemeName,
  loadLocalSettings,
  saveSelectedModel,
  saveSelectedTheme,
  saveSubagentPanelVisible,
  saveThinkingVisible,
  type ThemeName,
} from "../local/settings.js"
import { calculateLocalStats } from "../local/stats.js"
import {
  createPermissionPolicy,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRule,
} from "../permissions/policy.js"
import { loadProjectPermissionRules } from "../permissions/project-policy.js"
import { emptySkillCatalog, loadSkillCatalog, type SkillCatalog } from "../skills/index.js"
import type { JsonlSession, PromptAdmission } from "../storage/index.js"
import { describeToolCall } from "../tools/index.js"
import { ParallelClient } from "../web/client.js"
import { runAgentTurn } from "./agent-turn.js"
import { createChatUI } from "./chat-ui.js"
import { contextUsage, contextUsageColor, formatContextUsage } from "./context-meter.js"
import { ImageFlow } from "./image-flow.js"
import { SessionController } from "./session-controller.js"
import { type PreparedModelSelection, SetupFlow } from "./setup-flow.js"
import { parseSlashCommand, type SlashCommand, slashCommandRunsImmediately, slashCommands } from "./slash-commands.js"
import { SubagentTraces } from "./subagents.js"
import { initializeTreeSitterClient, TerminalController } from "./terminal.js"
import { colors, selectTheme } from "./theme.js"
import { TranscriptStore } from "./transcript.js"
import { formatLocalLoadStatus, formatModeLabel, formatModelName, withFastModelMark } from "./ui/format.js"
import type { ChatUI, Renderer } from "./ui/types.js"
import { checkForUpdate } from "./update.js"
import { formatWorkspaceLabel } from "./workspace-label.js"

const UPDATE_CHECK_TIMEOUT_MS = 5_000

type ActiveAgentTurn = {
  controller: AbortController
  steering: SteeringInbox
}

type PendingAction =
  | { type: "command"; command: SlashCommand }
  | { type: "model-selection"; model: ModelPickerItem }
  | { type: "session-selection"; sessionId: string }
  | { type: "session-deletion"; sessionId: string }
  | { type: "new-session" }
  | {
      type: "prompt"
      admission: PromptAdmission
      session: JsonlSession
      transcriptEntryId: number
    }

export class InteractiveApp {
  readonly #cwd = process.cwd()
  readonly #transcript = new TranscriptStore()
  readonly #subagents = new SubagentTraces()
  readonly #images = new ImageFlow({
    cwd: this.#cwd,
    isBusy: () => this.#busy,
    apiKey: () => this.#fireworksApiKey,
    selectedModelId: () => this.#selectedModelId,
    ui: () => this.#ui,
    transcript: this.#transcript,
    onContextChange: () => this.#updateContextIndicator(),
  })
  #renderer!: Renderer
  #ui!: ChatUI
  #sessions!: SessionController
  #setupFlow!: SetupFlow
  #terminal!: TerminalController
  #loadedProjectContext: ContextFile[] = []
  #loadedSkills: SkillCatalog = emptySkillCatalog()
  #busy = false
  #debug = false
  #exiting = false
  #quitPromise: Promise<void> | undefined
  #localModelManagementTask: Promise<void> | undefined
  #removeShutdownListeners: (() => void) | undefined
  #configured = false
  #fireworksApiKey: string | undefined
  #selectedModelId: string | undefined
  #selectedModelProvider: ModelProvider | undefined
  #pairEngine: PairEngine | undefined
  #pairEndpoints: PairEndpoints = {}
  #autoCompactAtTokens = autoCompactThreshold()
  #client: InferenceClient | undefined
  #llama = new LlamaCppRuntime()
  #webClient: ParallelClient | undefined
  #permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE
  #permissionRules: PermissionRule[] = []
  #selectedTheme: ThemeName = "default"
  #thinkingVisible = false
  #subagentPanelVisible = true
  #fastServingModels = new Set<string>()
  #fastAvailable = false
  #downloadedModelsAvailable = false
  #activeTurn: AbortController | undefined
  #activeAgentTurn: ActiveAgentTurn | undefined
  readonly #pendingActions: PendingAction[] = []
  #drainingPendingActions = false
  #updateCheckController: AbortController | undefined
  #startupModelController: AbortController | undefined
  #modelApplyId = 0
  #localLoadStatus: { modelId: string; status: ModelPickerStatus } | undefined
  #activeLocalModel:
    | { spec: LocalModelSpec; fit: LocalModelFit; hardware: HardwareProbe; contextLength: number }
    | undefined

  static async start() {
    const app = new InteractiveApp()
    await app.#boot()
  }

  async #boot() {
    const settings = await loadLocalSettings()
    const localInferenceUnavailableReason = supportsLlamaCppTarget(process)
      ? undefined
      : unsupportedLlamaCppTargetMessage(process)
    selectTheme(settings.theme)
    this.#selectedTheme = settings.theme ?? "default"
    this.#thinkingVisible = settings.thinkingVisible ?? false
    this.#subagentPanelVisible = settings.subagentPanelVisible ?? true
    this.#fastServingModels = new Set(settings.fastServingModels ?? [])
    this.#downloadedModelsAvailable = (await listDownloadedLocalModels()).length > 0
    this.#fireworksApiKey = settings.fireworksApiKey
    this.#selectedModelId = settings.model
    this.#selectedModelProvider =
      settings.modelProvider ?? (settings.model ? (isLocalModelId(settings.model) ? "local" : "fireworks") : undefined)
    this.#fastAvailable =
      this.#selectedModelProvider === "fireworks" &&
      (Boolean(settings.modelFastId) || isFastFireworksModel(settings.model ?? ""))
    this.#pairEngine = settings.pairEngine
    this.#pairEndpoints = { ...settings.pairEndpoints }
    const pairEndpoint = pairEndpointForEngine(this.#pairEndpoints, this.#pairEngine)
    this.#images.setModelCapability(settings.modelSupportsImageInput)
    this.#autoCompactAtTokens = autoCompactThreshold(
      compactionContextLength({
        provider: this.#selectedModelProvider,
        contextLength: settings.modelContextLength,
      }),
    )
    this.#permissionMode = settings.permissions?.defaultMode ?? DEFAULT_PERMISSION_MODE
    this.#permissionRules = [...(settings.permissions?.rules ?? []), ...(await loadProjectPermissionRules(this.#cwd))]
    this.#configured = Boolean(
      this.#selectedModelId &&
        ((this.#selectedModelProvider === "fireworks" && this.#fireworksApiKey) ||
          this.#selectedModelProvider === "local" ||
          (this.#selectedModelProvider === "pair" && pairEndpoint)),
    )
    if (this.#fireworksApiKey && this.#selectedModelId && this.#selectedModelProvider === "fireworks") {
      this.#client = new FireworksClient({ apiKey: this.#fireworksApiKey, model: this.#selectedModelId })
    }
    if (pairEndpoint && this.#selectedModelId && this.#selectedModelProvider === "pair") {
      this.#client = new PairClient({ baseURL: pairEndpoint, model: this.#selectedModelId })
    }
    this.#webClient = new ParallelClient()

    this.#renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      targetFps: 60,
      backgroundColor: colors.background,
    })

    const treeSitterClient = await initializeTreeSitterClient()
    this.#loadedProjectContext = loadProjectContext(this.#cwd)
    this.#loadedSkills = await loadSkillCatalog(this.#cwd)

    this.#ui = createChatUI(this.#renderer, {
      configured: this.#configured,
      localInferenceUnavailableReason,
      commands: slashCommands({
        fast: this.#fastAvailable,
      }),
      contextLabel: formatContextUsage(
        contextUsage(this.#contextEstimator()(this.#transcript.history), this.#autoCompactAtTokens),
      ),
      modelLabel:
        this.#selectedModelProvider === "pair"
          ? `${formatModelName(settings.modelDisplayName ?? this.#selectedModelId)} · NVIDIA PAIR`
          : this.#selectedModelProvider === "local"
            ? `${formatModelName(settings.modelDisplayName ?? this.#selectedModelId)} · Local`
            : withFastModelMark(
                formatModelName(settings.modelDisplayName ?? this.#selectedModelId),
                Boolean(this.#selectedModelId && isFastFireworksModel(this.#selectedModelId)),
              ),
      modeLabel: formatModeLabel(this.#permissionMode),
      sessionLabel: "Current session",
      theme: this.#selectedTheme,
      thinkingVisible: this.#thinkingVisible,
      subagentPanelVisible: this.#subagentPanelVisible,
      workspaceLabel: formatWorkspaceLabel(this.#cwd),
      treeSitterClient,
      onInputChange: (value) => this.#updateContextIndicator(value),
      onImagePaste: (bytes, mimeType) => this.#images.attachPasted(bytes, mimeType),
      onImagePathPaste: (value) => this.#images.handlePathPaste(value),
      onRemoveLastImage: () => this.#images.removeLast(),
      onInterrupt: () => {
        this.#activeTurn?.abort()
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
      client: () => this.#client,
      cwd: this.#cwd,
      transcript: this.#transcript,
      subagents: this.#subagents,
      ui: this.#ui,
      isBusy: () => this.#busy,
      isExiting: () => this.#exiting,
      onTranscriptChange: () => this.#updateContextIndicator(),
    })
    this.#setupFlow = new SetupFlow({
      settings,
      localInferenceUnavailableReason,
      isBusy: () => this.#busy,
      setBusy: (value) => {
        this.#busy = value
      },
      onCredentialsChanged: (credentials) => {
        this.#fireworksApiKey = credentials.fireworksApiKey
        if (credentials.fireworksApiKey && this.#selectedModelId && this.#selectedModelProvider === "fireworks") {
          this.#client = new FireworksClient({
            apiKey: credentials.fireworksApiKey,
            model: this.#selectedModelId,
          })
        }
        this.#ui.showStats()
        void this.#refreshLocalStats()
      },
      onPairEndpointsChanged: (endpoints) => {
        this.#pairEndpoints = { ...endpoints }
      },
      prepareModelSelection: (model, selection) =>
        this.#prepareSelectedModel(model, selection.fireworksApiKey, selection.signal),
      localLoadStatus: () => this.#localLoadStatus,
      loadedLocalModel: () =>
        this.#activeLocalModel
          ? { model: this.#activeLocalModel.spec.id, contextLength: this.#activeLocalModel.contextLength }
          : undefined,
      onConfigured: (fireworksKey) => {
        if (fireworksKey) this.#fireworksApiKey = fireworksKey
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
    if (this.#selectedModelId && this.#selectedModelProvider === "local") {
      const spec = findLocalModel(this.#selectedModelId)
      if (spec) {
        const startupController = new AbortController()
        this.#startupModelController = startupController
        let prepared: PreparedModelSelection | undefined
        try {
          prepared = await this.#prepareSelectedModel(
            catalogModelFromSpec(spec, settings.modelContextLength),
            this.#fireworksApiKey,
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
          this.#transcript.addAssistantMessage(
            `Could not start ${spec.displayName}: ${error instanceof Error ? error.message : String(error)}`,
          )
          this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
        } finally {
          if (this.#startupModelController === startupController) this.#startupModelController = undefined
        }
      }
    }
    if (!this.#configured && this.#fireworksApiKey && this.#selectedModelProvider !== "local") {
      this.#setupFlow.begin()
    }

    if (this.#transcript.entries.length > 0) {
      this.#ui.showChatLayout()
      this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
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
      if (this.#busy) await this.#queuePrompt(createUserMessage(command.prompt))
      else await this.#runPromptTurn(command.prompt)
      await this.#drainPendingActions()
      return
    }

    if (this.#busy && command && slashCommandRunsImmediately(command)) {
      await this.#runSlashCommand(command)
      return
    }

    if (this.#busy) {
      if (command) {
        this.#ui.clearInput()
        this.#pendingActions.push({ type: "command", command })
        return
      }

      const activeTurn = this.#activeAgentTurn
      if (activeTurn) await this.#steerActiveTurn(activeTurn, createUserMessage(value))
      else await this.#queuePrompt(createUserMessage(value))
      return
    }

    if (command) {
      await this.#runSlashCommand(command)
      await this.#drainPendingActions()
      return
    }

    if (!this.#configured || !this.#webClient) {
      this.#setupFlow.begin()
      return
    }

    if (!this.#client) return

    await this.#runPromptTurn(value)
    await this.#drainPendingActions()
  }

  async #steerActiveTurn(activeTurn: ActiveAgentTurn, message: UserChatMessage) {
    let transcriptEntryId: number | undefined
    const acceptance = activeTurn.steering.accept(message, () => {
      if (transcriptEntryId === undefined) return
      this.#transcript.activatePendingUserMessage(transcriptEntryId)
      if (!this.#exiting) this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
    })
    if (!acceptance.accepted) {
      await this.#queuePrompt(message)
      return
    }

    const entry = this.#transcript.addSteeringUserMessage(message)
    transcriptEntryId = entry.id
    this.#images.clear()
    this.#ui.clearInput()
    this.#updateContextIndicator()
    this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })

    try {
      await acceptance.persisted
    } catch (error) {
      this.#transcript.removeEntry(entry.id)
      this.#transcript.addDebugMessage(
        `Could not save steering message: ${error instanceof Error ? error.message : String(error)}`,
      )
      this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
    }
  }

  async #queuePrompt(message: UserChatMessage) {
    if (!this.#configured || !this.#webClient || !this.#client) return

    try {
      const session = await this.#sessions.ensure()
      const admission = await session.admitPrompt(message)
      const entry = this.#transcript.addQueuedUserMessage(message)
      const pending = { type: "prompt" as const, admission, session, transcriptEntryId: entry.id }
      const firstStateChange = this.#pendingActions.findIndex((action) => action.type !== "prompt")
      if (firstStateChange === -1) this.#pendingActions.push(pending)
      else this.#pendingActions.splice(firstStateChange, 0, pending)
      this.#images.clear()
      this.#ui.clearInput()
      this.#updateContextIndicator()
      this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
    } catch (error) {
      this.#transcript.addDebugMessage(
        `Could not queue prompt: ${error instanceof Error ? error.message : String(error)}`,
      )
      this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
    }
  }

  async #selectModel(model: ModelPickerItem) {
    if (this.#busy) {
      this.#ui.hideModelPicker()
      this.#pendingActions.push({ type: "model-selection", model })
      return
    }
    await this.#setupFlow.selectModel(model)
    await this.#drainPendingActions()
  }

  #startNewSession() {
    this.#images.clear()
    if (this.#busy) {
      this.#ui.hideSessionPicker()
      this.#pendingActions.push({ type: "new-session" })
      return
    }
    this.#sessions.startNew()
  }

  async #selectSession(sessionId: string) {
    this.#images.clear()
    if (this.#busy) {
      this.#ui.hideSessionPicker()
      this.#pendingActions.push({ type: "session-selection", sessionId })
      return
    }
    await this.#sessions.select(sessionId)
    await this.#drainPendingActions()
  }

  async #deleteSession(sessionId: string) {
    if (this.#busy) {
      this.#pendingActions.push({ type: "session-deletion", sessionId })
      return
    }
    await this.#sessions.delete(sessionId)
    await this.#drainPendingActions()
  }

  async #drainPendingActions() {
    if (this.#drainingPendingActions || this.#busy || this.#exiting) return
    this.#drainingPendingActions = true
    try {
      while (!this.#busy && !this.#exiting) {
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
      case "prompt":
        await this.#runPromptTurn("", pending)
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
        await this.#setupFlow.openModelPicker(this.#fireworksApiKey, this.#selectedModelId, true, {
          background: this.#busy,
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

  async #runPromptTurn(value: string, queued?: Extract<PendingAction, { type: "prompt" }>) {
    const activeClient = this.#client
    const activeWebClient = this.#webClient
    const activeProvider = this.#selectedModelProvider
    if (!activeClient || !activeWebClient || !activeProvider) return

    const ready = queued ? undefined : this.#images.ensureReadyToSend(value)
    if (ready) {
      try {
        await ready
      } catch (error) {
        this.#images.showMessage(`Could not send images: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }

    const turnController = new AbortController()
    this.#activeTurn = turnController
    this.#busy = true
    this.#ui.setBusy(true)
    this.#ui.showChatLayout()

    let admission: PromptAdmission
    let turnSession: JsonlSession
    const userMessage = queued?.admission.message ?? createUserMessage(value, this.#images.pending.items)
    try {
      turnSession = queued?.session ?? (await this.#sessions.ensure())
      admission = queued?.admission ?? (await turnSession.admitPrompt(userMessage))
    } catch (error) {
      if (this.#activeTurn === turnController) this.#activeTurn = undefined
      this.#busy = false
      this.#ui.setBusy(false)
      this.#transcript.addAssistantMessage(`Error: ${error instanceof Error ? error.message : String(error)}`)
      this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
      this.#ui.focusInput()
      return
    }

    const steering = new SteeringInbox(async (message) => {
      await turnSession.steerPrompt(admission, message)
    })
    this.#activeAgentTurn = { controller: turnController, steering }

    if (!queued || !this.#transcript.activatePendingUserMessage(queued.transcriptEntryId)) {
      this.#transcript.addUserMessage(userMessage)
    }
    if (this.#transcript.history.length === 0) {
      this.#sessions.setProvisionalLabel(value || summarizeUserMessage(userMessage))
    }
    this.#images.clear()
    this.#updateContextIndicator()

    this.#ui.clearInput()
    this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })

    try {
      const result = await runAgentTurn({
        admission,
        client: activeClient,
        webClient: activeWebClient,
        webClientModel: activeClient.model,
        webSessionId: turnSession.id,
        transcript: this.#transcript,
        subagents: this.#subagents,
        ui: this.#ui,
        cwd: this.#cwd,
        debug: this.#debug,
        signal: turnController.signal,
        projectContext: this.#loadedProjectContext,
        skills: this.#loadedSkills,
        tools: providerTools(activeProvider),
        autoCompactAtTokens: this.#autoCompactAtTokens,
        onCompaction: async (result, details, steeringCount) => {
          await turnSession.compactTurn(admission, result.summary, result.keptMessages, details, steeringCount)
        },
        onCompactionUsage: async (usage) => {
          await turnSession.recordUsage(usage, "compaction", admission.promptId)
        },
        isExiting: () => this.#exiting,
        onContext: (tokens) => {
          const usage = contextUsage(tokens, this.#autoCompactAtTokens)
          this.#ui.setContextLabel(formatContextUsage(usage), contextUsageColor(usage.percent))
        },
        onDiff: (added, removed) => {
          this.#sessions.addDiff(added, removed)
        },
        onUsage: async (usage) => {
          await turnSession.recordUsage(usage, "agent", admission.promptId)
        },
        permissionPolicy: createPermissionPolicy({
          cwd: this.#cwd,
          mode: this.#permissionMode,
          rules: this.#permissionRules,
        }),
        onPermissionRequest: (request) => this.#handlePermissionRequest(request),
        onCompletion: () => this.#terminal.notifyCompletion(),
        steering,
      })

      if (result.status === "interrupted" || result.status === "error") {
        try {
          await turnSession.interruptTurn(admission, result.messages, result.details)
        } catch (error) {
          this.#transcript.addDebugMessage(
            `Could not save interrupted turn: ${error instanceof Error ? error.message : String(error)}`,
          )
          if (!this.#exiting) this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
        }
        if (!this.#exiting) this.#updateContextIndicator()
        return
      }

      if (result.status !== "complete") {
        if (!this.#exiting && result.status !== "incomplete") this.#updateContextIndicator()
        return
      }

      this.#sessions.refreshLabel()
      this.#updateContextIndicator()
      this.#ui.renderTranscript(this.#transcript.entries)

      try {
        await turnSession.completeTurn(admission, result.messages, result.details)
      } catch (error) {
        this.#transcript.addDebugMessage(
          `Could not save turn: ${error instanceof Error ? error.message : String(error)}`,
        )
        this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
      }

      if (!turnSession.hasTitle()) void this.#sessions.generateTitle(turnSession)
    } finally {
      try {
        await steering.close()
      } catch (error) {
        this.#transcript.addDebugMessage(
          `Could not save steering message: ${error instanceof Error ? error.message : String(error)}`,
        )
        if (!this.#exiting) this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
      }
      if (this.#activeAgentTurn?.controller === turnController) this.#activeAgentTurn = undefined
      if (this.#activeTurn === turnController) this.#activeTurn = undefined
      this.#busy = false
      this.#ui.setBusy(false)
      if (!this.#exiting) {
        this.#ui.stopBusyIndicator()
        this.#ui.focusInput()
      }
    }
  }

  async #runCompaction(instructions?: string) {
    if (this.#busy) return
    const activeClient = this.#client
    if (!activeClient) return

    this.#busy = true
    this.#ui.setBusy(true)
    this.#ui.showChatLayout()
    this.#ui.startBusyIndicator()
    this.#transcript.addAssistantMessage("Compacting conversation…")
    this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })

    const compactionController = new AbortController()
    this.#activeTurn = compactionController

    try {
      const turnSession = await this.#sessions.ensure()
      const throughSeq = turnSession.events.at(-1)?.seq
      const result = await compactConversation(this.#transcript.history, {
        client: activeClient,
        instructions,
        targetTokens: Math.floor(this.#autoCompactAtTokens / 2),
        maxInputTokens: this.#autoCompactAtTokens,
        estimateContextTokens: this.#contextEstimator(),
        onUsage: async (usage) => {
          await turnSession.recordUsage(usage, "compaction")
        },
        signal: compactionController.signal,
      })
      const keptToolActivities = this.#transcript.toolActivitiesFor(result.keptMessages)
      const keptSubagents = this.#subagents.runsFor(result.keptMessages)

      await turnSession.compact(
        result.summary,
        result.keptMessages,
        { toolActivities: keptToolActivities, subagents: keptSubagents },
        throughSeq,
      )

      this.#transcript.loadCompacted(result.summary, result.keptMessages, keptToolActivities)
      this.#subagents.load(keptSubagents)
      this.#ui.renderSubagents(this.#subagents.all)
      this.#sessions.refreshLabel()
      this.#updateContextIndicator()
      this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
    } catch (error) {
      if (compactionController.signal.aborted) return
      this.#ui.showChatLayout()
      this.#transcript.addAssistantMessage(
        `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
    } finally {
      if (this.#activeTurn === compactionController) this.#activeTurn = undefined
      this.#busy = false
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
    this.#activeTurn?.abort()
    this.#startupModelController?.abort()
    this.#modelApplyId += 1
    try {
      await this.#setupFlow.shutdown()
      await this.#localModelManagementTask?.catch(() => undefined)
      await this.#llama.stop()
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
        description: this.#fireworksApiKey ? "Replace API key" : "Add API key",
        submission: "/settings hosted",
      },
      {
        name: "NVIDIA PAIR",
        description:
          this.#pairEndpoints.ollama || this.#pairEndpoints.lmStudio
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
        description: `${this.#selectedModelProvider === "local" && model.id === this.#selectedModelId ? "Active · " : ""}${model.quant} · ${formatMemoryLabel(localModelWeightBytes(model))}`,
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
    if (this.#exiting || this.#busy) return
    const spec = findLocalModel(modelId)
    if (!spec) return

    this.#busy = true
    this.#ui.setBusy(true)
    let active = false
    let settingsCleared = false
    let previousActive = this.#activeLocalModel
    let previousModel = catalogModelFromSpec(spec, previousActive?.contextLength)
    let remaining: LocalModelSpec[] = []

    try {
      await this.#setupFlow.cancelModelSelection()
      active = this.#selectedModelProvider === "local" && this.#selectedModelId === spec.id
      previousActive = this.#activeLocalModel
      previousModel = catalogModelFromSpec(spec, previousActive?.contextLength)
      const downloaded = await listDownloadedLocalModels()
      const deletingLast = downloaded.length === 1 && downloaded[0]?.id === spec.id

      if (active) {
        await clearSelectedModel()
        settingsCleared = true
      }
      if (active || deletingLast) await this.#llama.stop()
      await deleteLocalGguf(spec)
      remaining = await listDownloadedLocalModels()
    } catch (error) {
      let failure = error
      if (active && settingsCleared) {
        try {
          await saveSelectedModel(previousModel)
          if (previousActive) await this.#restoreLocalRuntime(previousActive)
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
      this.#modelApplyId += 1
      this.#activeLocalModel = undefined
      this.#selectedModelId = undefined
      this.#selectedModelProvider = undefined
      this.#client = undefined
      this.#configured = false
      this.#images.setModelCapability(false)
      this.#autoCompactAtTokens = autoCompactThreshold()
      this.#setupFlow.forgetSelectedModel(spec.id)
      if (this.#exiting) return
      this.#ui.setModelLabel("No model")
      this.#setFastAvailable(false)
      this.#updateContextIndicator()
      await this.#setupFlow.openModelPicker(this.#fireworksApiKey, undefined, true)
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
    const applyId = ++this.#modelApplyId
    if (this.#localLoadStatus && this.#localLoadStatus.modelId !== model.id) {
      this.#ui.setModelPickerStatus(this.#localLoadStatus.modelId, undefined)
      this.#localLoadStatus = undefined
    }
    const previousLocal = this.#activeLocalModel

    if (isLocalCatalogModel(model)) {
      const spec = findLocalModel(model.id)
      if (!spec) throw new Error(`Unknown local model: ${model.id}`)
      const name = `${formatModelName(model.displayName)} · Local`
      const hardware = await detectHardware()
      signal.throwIfAborted()
      const fit = fitLocalModel(spec, hardware)
      let serving: LocalServingEndpoint
      try {
        serving = await this.#llama.ensureServing(spec, fit, hardware, {
          signal,
          onProgress: (progress) => {
            if (applyId !== this.#modelApplyId || signal.aborted || this.#exiting) return
            const status: ModelPickerStatus = { label: formatLocalLoadStatus(progress), kind: "progress" }
            this.#localLoadStatus = { modelId: spec.id, status }
            this.#ui.setModelPickerStatus(spec.id, status)
          },
        })
        signal.throwIfAborted()
        this.#setDownloadedModelsAvailable(true)
      } catch (error) {
        this.#clearLocalLoadStatus(spec.id)
        await this.#refreshDownloadedModelAvailability()
        if (!signal.aborted && !this.#exiting) await this.#restoreLocalRuntime(previousLocal, error, signal)
        throw error
      }
      const activeModel = { ...model, contextLength: serving.contextLength }
      let finalized = false
      return {
        model: activeModel,
        commit: () => {
          if (finalized) return
          finalized = true
          this.#activeLocalModel = {
            spec,
            fit,
            hardware,
            contextLength: serving.contextLength,
          }
          this.#activateModel(
            activeModel,
            new LlamaCppClient({ model: spec.id, inferenceURL: serving.inferenceURL }),
            name,
          )
          this.#clearLocalLoadStatus(spec.id)
        },
        rollback: async ({ restorePrevious }) => {
          if (finalized) return
          finalized = true
          this.#clearLocalLoadStatus(spec.id)
          if (restorePrevious) await this.#restoreLocalRuntime(previousLocal, undefined, signal)
        },
      }
    }

    if (isPairCatalogModel(model)) {
      const client = new PairClient({ baseURL: model.baseURL, model: model.id })
      try {
        await this.#llama.stop()
        signal.throwIfAborted()
      } catch (error) {
        if (!signal.aborted && !this.#exiting) await this.#restoreLocalRuntime(previousLocal, error, signal)
        throw error
      }
      let finalized = false
      return {
        model,
        commit: () => {
          if (finalized) return
          finalized = true
          this.#activeLocalModel = undefined
          this.#activateModel(model, client, `${formatModelName(model.displayName)} · NVIDIA PAIR`)
        },
        rollback: async ({ restorePrevious }) => {
          if (finalized) return
          finalized = true
          if (restorePrevious) await this.#restoreLocalRuntime(previousLocal, undefined, signal)
        },
      }
    }

    if (!fireworksApiKey) throw new Error("Fireworks API key is required.")
    try {
      await this.#llama.stop()
      signal.throwIfAborted()
    } catch (error) {
      if (!signal.aborted && !this.#exiting) await this.#restoreLocalRuntime(previousLocal, error, signal)
      throw error
    }
    const client = new FireworksClient({ apiKey: fireworksApiKey, model: model.id })
    let finalized = false
    return {
      model,
      commit: () => {
        if (finalized) return
        finalized = true
        this.#activeLocalModel = undefined
        this.#activateModel(
          model,
          client,
          withFastModelMark(formatModelName(model.displayName), isFastFireworksModel(model.id)),
        )
      },
      rollback: async ({ restorePrevious }) => {
        if (finalized) return
        finalized = true
        if (restorePrevious) await this.#restoreLocalRuntime(previousLocal, undefined, signal)
      },
    }
  }

  #activateModel(model: CatalogModel, client: InferenceClient, label: string) {
    this.#selectedModelId = model.id
    this.#selectedModelProvider = model.provider
    this.#pairEngine = model.provider === "pair" ? model.engine : undefined
    this.#images.setModelCapability(model.supportsImageInput)
    this.#autoCompactAtTokens = autoCompactThreshold(compactionContextLength(model))
    this.#client = client
    this.#configured = true
    if (!this.#exiting) {
      this.#ui.setModelLabel(label)
      this.#setFastAvailable(
        model.provider === "fireworks" && (Boolean(model.fastId) || isFastFireworksModel(model.id)),
      )
      this.#updateContextIndicator()
    }
  }

  async #restoreLocalRuntime(
    previous: { spec: LocalModelSpec; fit: LocalModelFit; hardware: HardwareProbe; contextLength: number } | undefined,
    originalError?: unknown,
    signal?: AbortSignal,
  ) {
    try {
      if (!previous) {
        await this.#llama.stop()
        return
      }
      const serving = await this.#llama.ensureServing(previous.spec, previous.fit, previous.hardware, { signal })
      signal?.throwIfAborted()
      previous.contextLength = serving.contextLength
      this.#activeLocalModel = previous
      this.#client = new LlamaCppClient({ model: previous.spec.id, inferenceURL: serving.inferenceURL })
      this.#selectedModelProvider = "local"
      if (this.#selectedModelId === previous.spec.id) {
        this.#autoCompactAtTokens = autoCompactThreshold(serving.contextLength)
        if (!this.#exiting) this.#updateContextIndicator()
      }
    } catch (restoreError) {
      if (originalError === undefined) throw restoreError
      throw new AggregateError(
        [originalError, restoreError],
        `${errorMessage(originalError)} The previous local model could not be restored.`,
      )
    }
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

  #updateContextIndicator(pendingInput = "") {
    const pendingMessage = createUserMessage(pendingInput, this.#images.pending.items)
    const usage = contextUsage(
      this.#contextEstimator()([
        ...this.#transcript.history,
        ...(pendingInput || this.#images.pending.items.length > 0 ? [pendingMessage] : []),
      ]),
      this.#autoCompactAtTokens,
    )
    this.#ui.setContextLabel(formatContextUsage(usage), contextUsageColor(usage.percent))
  }

  #contextEstimator() {
    const tools = providerTools(this.#selectedModelProvider ?? "fireworks").filter(
      (tool) => tool.name !== "skill" || this.#loadedSkills.skills.length > 0,
    )
    return requestContextEstimator({
      tools,
      projectContext: this.#loadedProjectContext,
      skills: tools.some((tool) => tool.name === "skill") ? this.#loadedSkills.skills : [],
    })
  }

  #toggleMode() {
    this.#permissionMode = this.#permissionMode === "ask" ? "auto" : "ask"
    this.#ui.setModeLabel(formatModeLabel(this.#permissionMode))
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
    if (!this.#configured || !this.#fireworksApiKey || !this.#selectedModelId) {
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
      this.#transcript.addDebugMessage(
        `Could not save subagent panel visibility: ${error instanceof Error ? error.message : String(error)}`,
      )
      this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
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
      this.#transcript.addDebugMessage(
        `Could not save thinking visibility: ${error instanceof Error ? error.message : String(error)}`,
      )
      this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
    }
  }

  #showThemeMessage(message: string) {
    this.#ui.showChatLayout()
    this.#transcript.addAssistantMessage(message)
    this.#ui.clearInput()
    this.#ui.renderTranscript(this.#transcript.entries)
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
