import { createCliRenderer } from "@opentui/core"
import { autoCompactThreshold, compactConversation } from "../core/compaction.js"
import { loadProjectContext } from "../core/context.js"
import { FireworksClient } from "../inference/client.js"
import { createUserMessage, summarizeUserMessage, userMessageContentChars } from "../inference/messages.js"
import { isFastFireworksModel } from "../inference/serving-path.js"
import { skillAdvertisementChars } from "../inference/system-prompt.js"
import type { ContextFile, FireworksModel } from "../inference/types.js"
import {
  isThemeName,
  loadLocalSettings,
  saveSelectedTheme,
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
import { contextUsage, contextUsageColor, estimateContextTokens, formatContextUsage } from "./context-meter.js"
import { ImageFlow } from "./image-flow.js"
import { SessionController } from "./session-controller.js"
import { SetupFlow } from "./setup-flow.js"
import { parseSlashCommand, type SlashCommand, slashCommandIgnoresBusy, slashCommands } from "./slash-commands.js"
import { initializeTreeSitterClient, TerminalController } from "./terminal.js"
import { colors, selectTheme } from "./theme.js"
import { TranscriptStore } from "./transcript.js"
import { formatModeLabel, formatModelName, withFastModelMark } from "./ui/format.js"
import type { ChatUI, Renderer } from "./ui/types.js"
import { checkForUpdate } from "./update.js"
import { formatWorkspaceLabel } from "./workspace-label.js"

const UPDATE_CHECK_TIMEOUT_MS = 5_000

export class InteractiveApp {
  readonly #cwd = process.cwd()
  readonly #transcript = new TranscriptStore()
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
  #staticContextChars = 0
  #loadedProjectContext: ContextFile[] = []
  #loadedSkills: SkillCatalog = emptySkillCatalog()
  #busy = false
  #debug = false
  #exiting = false
  #configured = false
  #fireworksApiKey: string | undefined
  #selectedModelId: string | undefined
  #autoCompactAtTokens = autoCompactThreshold()
  #client: FireworksClient | undefined
  #webClient: ParallelClient | undefined
  #permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE
  #permissionRules: PermissionRule[] = []
  #selectedTheme: ThemeName = "default"
  #thinkingVisible = false
  #fastMode = true
  #fastAvailable = false
  #activeTurn: AbortController | undefined
  #updateCheckController: AbortController | undefined

  static async start() {
    const app = new InteractiveApp()
    await app.#boot()
  }

  async #boot() {
    const settings = await loadLocalSettings()
    selectTheme(settings.theme)
    this.#selectedTheme = settings.theme ?? "default"
    this.#thinkingVisible = settings.thinkingVisible ?? false
    this.#fastMode = settings.fastMode ?? true
    this.#fastAvailable = Boolean(settings.modelFastId) || isFastFireworksModel(settings.model ?? "")
    this.#fireworksApiKey = settings.fireworksApiKey
    this.#selectedModelId = settings.model
    this.#images.setModelCapability(settings.modelSupportsImageInput)
    this.#autoCompactAtTokens = autoCompactThreshold(settings.modelContextLength)
    this.#permissionMode = settings.permissions?.defaultMode ?? DEFAULT_PERMISSION_MODE
    this.#permissionRules = [...(settings.permissions?.rules ?? []), ...(await loadProjectPermissionRules(this.#cwd))]
    this.#configured = Boolean(this.#fireworksApiKey && this.#selectedModelId)
    if (this.#fireworksApiKey && this.#selectedModelId) {
      this.#client = new FireworksClient({ apiKey: this.#fireworksApiKey, model: this.#selectedModelId })
    }
    this.#webClient = new ParallelClient()

    this.#renderer = await createCliRenderer({
      exitOnCtrlC: true,
      targetFps: 60,
      backgroundColor: colors.background,
    })

    const treeSitterClient = await initializeTreeSitterClient()
    this.#loadedProjectContext = loadProjectContext(this.#cwd)
    this.#loadedSkills = await loadSkillCatalog(this.#cwd)
    this.#staticContextChars =
      this.#loadedProjectContext.reduce((sum, file) => sum + file.content.length, 0) +
      skillAdvertisementChars(this.#loadedSkills.skills)

    this.#ui = createChatUI(this.#renderer, {
      configured: this.#configured,
      statsVisible: Boolean(this.#fireworksApiKey),
      commands: slashCommands({ fast: this.#fastAvailable }),
      contextLabel: formatContextUsage(
        contextUsage(
          estimateContextTokens(this.#transcript.history, this.#staticContextChars),
          this.#autoCompactAtTokens,
        ),
      ),
      modelLabel: withFastModelMark(
        formatModelName(settings.modelDisplayName ?? this.#selectedModelId),
        Boolean(this.#selectedModelId && isFastFireworksModel(this.#selectedModelId)),
      ),
      modeLabel: formatModeLabel(this.#permissionMode),
      sessionLabel: "Current session",
      theme: this.#selectedTheme,
      thinkingVisible: this.#thinkingVisible,
      workspaceLabel: formatWorkspaceLabel(this.#cwd),
      treeSitterClient,
      onInputChange: (value) => this.#updateContextIndicator(value),
      onImagePaste: (bytes, mimeType) => this.#images.attachPasted(bytes, mimeType),
      onImagePathPaste: (value) => this.#images.handlePathPaste(value),
      onRemoveLastImage: () => this.#images.removeLast(),
      onInterrupt: () => {
        this.#activeTurn?.abort()
      },
      onSetup: () => this.#setupFlow.begin(),
      onSetupSubmit: (apiKey) => {
        void this.#setupFlow.submitCredential(apiKey)
      },
      onCloseModelPicker: () => this.#setupFlow.closeModelPicker(),
      onSelectModel: (model) => {
        void this.#setupFlow.selectModel(model)
      },
      onNewSession: () => {
        this.#images.clear()
        this.#sessions.startNew()
      },
      onDeleteSession: (sessionId) => {
        void this.#sessions.delete(sessionId)
      },
      onSelectSession: (sessionId) => {
        this.#images.clear()
        void this.#sessions.select(sessionId)
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
      ui: this.#ui,
      isBusy: () => this.#busy,
      isExiting: () => this.#exiting,
      onTranscriptChange: () => this.#updateContextIndicator(),
    })
    this.#setupFlow = new SetupFlow({
      settings,
      isBusy: () => this.#busy,
      setBusy: (value) => {
        this.#busy = value
      },
      onCredentialsChanged: (credentials) => {
        this.#fireworksApiKey = credentials.fireworksApiKey
        if (this.#fireworksApiKey && this.#selectedModelId) {
          this.#client = new FireworksClient({ apiKey: this.#fireworksApiKey, model: this.#selectedModelId })
        }
        this.#ui.showStats()
        void this.#refreshLocalStats()
      },
      onModelSelected: (model) => this.#applySelectedModel(model),
      onConfigured: (fireworksKey: string, model: FireworksModel) => {
        this.#fireworksApiKey = fireworksKey
        this.#applySelectedModel(model)
        this.#configured = true
        void this.#refreshLocalStats()
      },
      fastMode: () => this.#fastMode,
      onFastModeChanged: (fast) => {
        this.#fastMode = fast
      },
      ui: this.#ui,
    })
    this.#terminal = new TerminalController(
      this.#renderer,
      () => this.#exiting,
      () => this.#ui.focusInput(),
    )
    this.#terminal.installRecovery()
    this.#startUpdateCheck()

    if (this.#fireworksApiKey) void this.#refreshLocalStats()
    if (!this.#configured && this.#fireworksApiKey) this.#setupFlow.begin()

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
    if (command && slashCommandIgnoresBusy(command)) {
      await this.#runSlashCommand(command)
      return
    }

    if (this.#busy) return

    if (!this.#configured || !this.#fireworksApiKey || !this.#client || !this.#webClient) {
      this.#setupFlow.begin()
      return
    }

    if (command) {
      await this.#runSlashCommand(command)
      return
    }

    await this.#runPromptTurn(value)
  }

  async #runSlashCommand(command: SlashCommand) {
    switch (command.type) {
      case "exit":
        this.#quit()
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
        const apiKey = this.#fireworksApiKey
        if (!apiKey) return
        this.#ui.clearInput()
        await this.#setupFlow.openModelPicker(apiKey, this.#selectedModelId, true)
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
      case "debug":
        this.#debug = !this.#debug
        this.#ui.showChatLayout()
        this.#transcript.addUserMessage("/debug")
        this.#transcript.addAssistantMessage(`Debug mode ${this.#debug ? "enabled" : "disabled"}.`)
        this.#ui.clearInput()
        this.#updateContextIndicator()
        this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
        this.#ui.focusInput()
        return
      case "thinking":
        await this.#setThinkingVisible(!this.#thinkingVisible)
        return
      case "compact":
        this.#ui.clearInput()
        await this.#runCompaction(command.instructions)
        return
    }
  }

  async #runPromptTurn(value: string) {
    const activeClient = this.#client
    const activeWebClient = this.#webClient
    if (!activeClient || !activeWebClient) return

    const ready = this.#images.ensureReadyToSend(value)
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
    const userMessage = createUserMessage(value, this.#images.pending.items)
    try {
      turnSession = await this.#sessions.ensure()
      admission = await turnSession.admitPrompt(userMessage)
    } catch (error) {
      if (this.#activeTurn === turnController) this.#activeTurn = undefined
      this.#busy = false
      this.#ui.setBusy(false)
      this.#transcript.addAssistantMessage(`Error: ${error instanceof Error ? error.message : String(error)}`)
      this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
      this.#ui.focusInput()
      return
    }

    this.#transcript.addUserMessage(userMessage)
    if (this.#transcript.history.length === 0) {
      this.#sessions.setProvisionalLabel(value || summarizeUserMessage(userMessage))
    }
    this.#images.clear()
    this.#updateContextIndicator()

    this.#ui.clearInput()
    this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })

    let result: Awaited<ReturnType<typeof runAgentTurn>>
    try {
      result = await runAgentTurn({
        admission,
        client: activeClient,
        webClient: activeWebClient,
        webClientModel: activeClient.model,
        webSessionId: turnSession.id,
        transcript: this.#transcript,
        ui: this.#ui,
        cwd: this.#cwd,
        debug: this.#debug,
        signal: turnController.signal,
        projectContext: this.#loadedProjectContext,
        skills: this.#loadedSkills,
        staticContextChars: this.#staticContextChars,
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
      })
    } finally {
      if (this.#activeTurn === turnController) this.#activeTurn = undefined
      this.#busy = false
      this.#ui.setBusy(false)
      if (!this.#exiting) {
        this.#ui.stopBusyIndicator()
        this.#ui.focusInput()
      }
    }

    if (result.status === "interrupted") {
      try {
        await turnSession.interruptTurn(admission, result.messages, result.toolActivities)
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
      await turnSession.completeTurn(admission, result.messages, result.toolActivities)
    } catch (error) {
      this.#transcript.addDebugMessage(`Could not save turn: ${error instanceof Error ? error.message : String(error)}`)
      this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
    }

    if (!turnSession.hasTitle()) {
      void this.#sessions.generateTitle(turnSession)
    }

    if (estimateContextTokens(this.#transcript.history, this.#staticContextChars) >= this.#autoCompactAtTokens) {
      await this.#runCompaction(undefined, true)
    }
  }

  async #runCompaction(instructions?: string, auto = false) {
    if (this.#busy) return
    const activeClient = this.#client
    if (!activeClient) return
    if (this.#transcript.history.length < 4) {
      if (!auto) {
        this.#ui.showChatLayout()
        this.#transcript.addAssistantMessage("Not enough conversation history to compact.")
        this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })
        this.#ui.focusInput()
      }
      return
    }

    this.#busy = true
    this.#ui.setBusy(true)
    this.#ui.showChatLayout()
    this.#ui.startBusyIndicator()
    this.#transcript.addAssistantMessage(
      auto ? "Context window filling up — auto-compacting conversation…" : "Compacting conversation…",
    )
    this.#ui.renderTranscript(this.#transcript.entries, { scrollToBottom: true })

    const compactionController = new AbortController()
    this.#activeTurn = compactionController

    try {
      const turnSession = await this.#sessions.ensure()
      const result = await compactConversation(this.#transcript.history, {
        client: activeClient,
        instructions,
        onUsage: async (usage) => {
          await turnSession.recordUsage(usage, "compaction")
        },
        signal: compactionController.signal,
      })
      const keptToolActivities = this.#transcript.toolActivitiesFor(result.keptMessages)

      await turnSession.compact(result.summary, result.keptMessages, keptToolActivities)

      this.#transcript.loadCompacted(result.summary, result.keptMessages, keptToolActivities)
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

  #quit() {
    this.#exiting = true
    this.#updateCheckController?.abort()
    this.#activeTurn?.abort()
    this.#renderer.destroy()
  }

  async #refreshLocalStats() {
    try {
      const stats = await calculateLocalStats()
      if (!this.#exiting) this.#ui.setStats(stats)
    } catch {
      // A damaged or temporarily unavailable local stats file must not block the CLI.
    }
  }

  #applySelectedModel(model: FireworksModel) {
    this.#selectedModelId = model.id
    this.#images.setModelCapability(model.supportsImageInput)
    this.#autoCompactAtTokens = autoCompactThreshold(model.contextLength)
    if (this.#fireworksApiKey) this.#client = new FireworksClient({ apiKey: this.#fireworksApiKey, model: model.id })
    this.#ui.setModelLabel(withFastModelMark(formatModelName(model.displayName), isFastFireworksModel(model.id)))
    this.#setFastAvailable(Boolean(model.fastId) || isFastFireworksModel(model.id))
    this.#updateContextIndicator()
  }

  #setFastAvailable(available: boolean) {
    this.#fastAvailable = available
    this.#ui.setCommands(slashCommands({ fast: available }))
  }

  #updateContextIndicator(pendingInput = "") {
    const pendingMessage = createUserMessage(pendingInput, this.#images.pending.items)
    const usage = contextUsage(
      estimateContextTokens(
        this.#transcript.history,
        this.#staticContextChars,
        userMessageContentChars(pendingMessage),
      ),
      this.#autoCompactAtTokens,
    )
    this.#ui.setContextLabel(formatContextUsage(usage), contextUsageColor(usage.percent))
  }

  #toggleMode() {
    if (this.#busy) return
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
