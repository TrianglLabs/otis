import { createCliRenderer } from "@opentui/core"
import { autoCompactThreshold, compactConversation } from "../core/compaction.js"
import { loadProjectContext } from "../core/context.js"
import { FireworksClient } from "../inference/client.js"
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
  type PermissionMode,
  type PermissionRequest,
  type PermissionRule,
} from "../permissions/policy.js"
import { loadProjectPermissionRules } from "../permissions/project-policy.js"
import type { JsonlSession, PromptAdmission } from "../storage/index.js"
import { describeToolCall } from "../tools/index.js"
import { ParallelClient } from "../web/client.js"
import { runAgentTurn } from "./agent-turn.js"
import { type CommandSuggestion, createChatUI } from "./chat-ui.js"
import { contextUsage, contextUsageColor, estimateContextTokens, formatContextUsage } from "./context-meter.js"
import { SessionController } from "./session-controller.js"
import { SetupFlow } from "./setup-flow.js"
import { initializeTreeSitterClient, TerminalController } from "./terminal.js"
import { colors, selectTheme } from "./theme.js"
import { TranscriptStore } from "./transcript.js"
import { checkForUpdate } from "./update.js"

const UPDATE_CHECK_TIMEOUT_MS = 5_000
const workspaceCwd = process.cwd()
const COMMANDS: CommandSuggestion[] = [
  { name: "/home", description: "Return to home screen" },
  { name: "/new", description: "Start a new session" },
  { name: "/history", description: "Open session history" },
  { name: "/model", description: "Choose a Fireworks model" },
  { name: "/compact", description: "Summarize old conversation to free context" },
  { name: "/debug", description: "Toggle debug messages" },
  { name: "/thinking", description: "Show or hide model thinking traces" },
  { name: "/theme", description: "Choose default, nord, bright, or matrix theme" },
  { name: "/theme default", description: "" },
  { name: "/theme nord", description: "" },
  { name: "/theme bright", description: "" },
  { name: "/theme matrix", description: "" },
  { name: "/exit", description: "Exit Otis" },
]

const transcript = new TranscriptStore()
let renderer: Awaited<ReturnType<typeof createCliRenderer>>
let ui: ReturnType<typeof createChatUI>
let projectContextChars = 0
let loadedProjectContext: ContextFile[] = []
let busy = false
let debug = false
let exiting = false
let configured = false
let fireworksApiKey: string | undefined
let parallelApiKey: string | undefined
let selectedModelId: string | undefined
let autoCompactAtTokens = autoCompactThreshold()
let client: FireworksClient | undefined
let webClient: ParallelClient | undefined
let permissionMode: PermissionMode = "ask"
let permissionRules: PermissionRule[] = []
let selectedTheme: ThemeName = "default"
let thinkingVisible = false
let activeTurn: AbortController | undefined
let updateCheckController: AbortController | undefined
let setupFlow: SetupFlow
let sessions: SessionController
let terminal: TerminalController

export async function startInteractiveCli() {
  const settings = await loadLocalSettings()
  selectTheme(settings.theme)
  selectedTheme = settings.theme ?? "default"
  thinkingVisible = settings.thinkingVisible ?? false
  fireworksApiKey = settings.fireworksApiKey
  parallelApiKey = settings.parallelApiKey
  selectedModelId = settings.model
  autoCompactAtTokens = autoCompactThreshold(settings.modelContextLength)
  permissionMode = settings.permissions?.defaultMode ?? "ask"
  permissionRules = [...(settings.permissions?.rules ?? []), ...(await loadProjectPermissionRules(workspaceCwd))]
  configured = Boolean(fireworksApiKey && parallelApiKey && selectedModelId)
  if (fireworksApiKey && selectedModelId) {
    client = new FireworksClient({ apiKey: fireworksApiKey, model: selectedModelId })
  }
  if (parallelApiKey) webClient = new ParallelClient({ apiKey: parallelApiKey })

  renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
    backgroundColor: colors.background,
  })

  const treeSitterClient = await initializeTreeSitterClient()
  loadedProjectContext = loadProjectContext(workspaceCwd)
  projectContextChars = loadedProjectContext.reduce((sum, file) => sum + file.content.length, 0)

  ui = createChatUI(renderer, {
    configured,
    statsVisible: Boolean(fireworksApiKey || parallelApiKey),
    commands: COMMANDS,
    contextLabel: formatContextUsage(
      contextUsage(estimateContextTokens(transcript.history, projectContextChars), autoCompactAtTokens),
    ),
    modelLabel: formatModelName(settings.modelDisplayName ?? selectedModelId),
    modeLabel: formatModeLabel(permissionMode),
    sessionLabel: "Current session",
    theme: selectedTheme,
    thinkingVisible,
    treeSitterClient,
    onInputChange: (value) => updateContextIndicator(value),
    onInterrupt: () => {
      activeTurn?.abort()
    },
    onSetup: () => setupFlow.begin(),
    onSetupSubmit: (credential, apiKey) => {
      void setupFlow.submitCredential(credential, apiKey)
    },
    onCloseModelPicker: () => setupFlow.closeModelPicker(),
    onSelectModel: (model) => {
      void setupFlow.selectModel(model)
    },
    onNewSession: () => {
      sessions.startNew()
    },
    onDeleteSession: (sessionId) => {
      void sessions.delete(sessionId)
    },
    onSelectSession: (sessionId) => {
      void sessions.select(sessionId)
    },
    onSubmit: handleInput,
    onPreviewTheme: previewTheme,
    onCancelThemePreview: () => previewTheme(selectedTheme),
    onToggleMode: toggleMode,
  })
  sessions = new SessionController({
    client: () => client,
    cwd: workspaceCwd,
    transcript,
    ui,
    isBusy: () => busy,
    isExiting: () => exiting,
    onTranscriptChange: updateContextIndicator,
  })
  setupFlow = new SetupFlow({
    settings,
    isBusy: () => busy,
    setBusy: (value) => {
      busy = value
    },
    onCredentialsChanged: (credentials) => {
      fireworksApiKey = credentials.fireworksApiKey
      parallelApiKey = credentials.parallelApiKey
      if (fireworksApiKey && selectedModelId) {
        client = new FireworksClient({ apiKey: fireworksApiKey, model: selectedModelId })
      }
      if (parallelApiKey) webClient = new ParallelClient({ apiKey: parallelApiKey })
      ui.showStats()
      void refreshLocalStats()
    },
    onModelSelected: applySelectedModel,
    onConfigured: (fireworksKey: string, parallelKey: string, model: FireworksModel) => {
      fireworksApiKey = fireworksKey
      parallelApiKey = parallelKey
      webClient = new ParallelClient({ apiKey: parallelKey })
      applySelectedModel(model)
      configured = true
      void refreshLocalStats()
    },
    ui,
  })
  terminal = new TerminalController(
    renderer,
    () => exiting,
    () => ui.focusInput(),
  )
  terminal.installRecovery()
  const updateController = new AbortController()
  updateCheckController = updateController
  const updateTimeout = setTimeout(() => updateController.abort(), UPDATE_CHECK_TIMEOUT_MS)
  updateTimeout.unref?.()
  void checkForUpdate({ signal: updateController.signal })
    .then((result) => {
      if (result?.available && !exiting) ui.showUpdateHint()
    })
    .catch(() => {
      // Update check is best-effort; silently ignore network or manifest failures.
    })
    .finally(() => {
      clearTimeout(updateTimeout)
      if (updateCheckController === updateController) updateCheckController = undefined
    })

  if (fireworksApiKey || parallelApiKey) void refreshLocalStats()

  if (!configured && (fireworksApiKey || parallelApiKey)) setupFlow.begin()

  if (transcript.entries.length > 0) {
    ui.showChatLayout()
    ui.renderTranscript(transcript.entries, { scrollToBottom: true })
  }
}

async function handleInput(value: string) {
  if (!value) return

  ui.hideUpdateHint()

  if (value === "/exit") {
    quit()
    return
  }

  if (value === "/theme") {
    ui.clearInput()
    ui.showThemeMenu()
    ui.focusInput()
    return
  }

  if (value.startsWith("/theme ")) {
    await selectThemeCommand(value)
    return
  }

  if (busy) return

  const activeClient = client
  const activeWebClient = webClient
  if (!configured || !fireworksApiKey || !parallelApiKey || !activeClient || !activeWebClient) {
    setupFlow.begin()
    return
  }

  if (value === "/model") {
    ui.clearInput()
    await setupFlow.openModelPicker(fireworksApiKey, selectedModelId, true)
    return
  }

  if (value === "/history") {
    ui.clearInput()
    await sessions.openPicker()
    return
  }

  if (value === "/new") {
    ui.clearInput()
    sessions.startNew()
    return
  }

  if (value === "/home") {
    ui.clearInput()
    ui.showHomeLayout()
    void refreshLocalStats()
    ui.focusInput()
    return
  }

  if (value === "/debug") {
    debug = !debug
    ui.showChatLayout()
    transcript.addUserMessage(value)
    transcript.addAssistantMessage(`Debug mode ${debug ? "enabled" : "disabled"}.`)
    ui.clearInput()
    updateContextIndicator()
    ui.renderTranscript(transcript.entries, { scrollToBottom: true })
    ui.focusInput()
    return
  }

  if (value === "/thinking") {
    await setThinkingVisible(!thinkingVisible)
    return
  }

  if (value === "/compact" || value.startsWith("/compact ")) {
    ui.clearInput()
    const instructions = value.slice("/compact".length).trim() || undefined
    await runCompaction(instructions)
    return
  }

  const turnController = new AbortController()
  activeTurn = turnController
  busy = true
  ui.setBusy(true)
  ui.showChatLayout()

  let admission: PromptAdmission
  let turnSession: JsonlSession
  try {
    turnSession = await sessions.ensure()
    admission = await turnSession.admitPrompt(value)
  } catch (error) {
    if (activeTurn === turnController) activeTurn = undefined
    busy = false
    ui.setBusy(false)
    transcript.addAssistantMessage(`Error: ${error instanceof Error ? error.message : String(error)}`)
    ui.renderTranscript(transcript.entries, { scrollToBottom: true })
    ui.focusInput()
    return
  }

  transcript.addUserMessage(value)
  if (transcript.history.length === 0) sessions.setProvisionalLabel(value)
  updateContextIndicator(value)

  ui.clearInput()
  ui.renderTranscript(transcript.entries, { scrollToBottom: true })

  let result: Awaited<ReturnType<typeof runAgentTurn>>
  try {
    result = await runAgentTurn({
      input: value,
      admission,
      client: activeClient,
      webClient: activeWebClient,
      webClientModel: activeClient.model,
      transcript,
      ui,
      cwd: workspaceCwd,
      debug,
      signal: turnController.signal,
      projectContext: loadedProjectContext,
      projectContextChars,
      isExiting: () => exiting,
      onContext: (tokens) => {
        const usage = contextUsage(tokens, autoCompactAtTokens)
        ui.setContextLabel(formatContextUsage(usage), contextUsageColor(usage.percent))
      },
      onDiff: (added, removed) => {
        sessions.addDiff(added, removed)
      },
      onUsage: async (usage) => {
        await turnSession.recordUsage(usage, "agent", admission.promptId)
      },
      permissionPolicy: createPermissionPolicy({ cwd: workspaceCwd, mode: permissionMode, rules: permissionRules }),
      onPermissionRequest: handlePermissionRequest,
      onCompletion: () => terminal.notifyCompletion(),
    })
  } finally {
    if (activeTurn === turnController) activeTurn = undefined
    busy = false
    ui.setBusy(false)
    if (!exiting) {
      ui.stopBusyIndicator()
      ui.focusInput()
    }
  }

  if (result.status === "interrupted") {
    try {
      await turnSession.interruptTurn(admission, result.messages, result.toolActivities)
    } catch (error) {
      transcript.addDebugMessage(
        `Could not save interrupted turn: ${error instanceof Error ? error.message : String(error)}`,
      )
      if (!exiting) ui.renderTranscript(transcript.entries, { scrollToBottom: true })
    }
    if (!exiting) updateContextIndicator()
    return
  }

  if (result.status !== "complete") {
    if (!exiting && result.status !== "incomplete") updateContextIndicator()
    return
  }

  sessions.refreshLabel()
  updateContextIndicator()
  ui.renderTranscript(transcript.entries)

  try {
    await turnSession.completeTurn(admission, result.messages, result.toolActivities)
  } catch (error) {
    transcript.addDebugMessage(`Could not save turn: ${error instanceof Error ? error.message : String(error)}`)
    ui.renderTranscript(transcript.entries, { scrollToBottom: true })
  }

  if (!turnSession.hasTitle()) {
    void sessions.generateTitle(turnSession)
  }

  if (estimateContextTokens(transcript.history, projectContextChars) >= autoCompactAtTokens) {
    await runCompaction(undefined, true)
  }
}

async function runCompaction(instructions?: string, auto = false) {
  if (busy) return
  const activeClient = client
  if (!activeClient) return
  if (transcript.history.length < 4) {
    if (!auto) {
      ui.showChatLayout()
      transcript.addAssistantMessage("Not enough conversation history to compact.")
      ui.renderTranscript(transcript.entries, { scrollToBottom: true })
      ui.focusInput()
    }
    return
  }

  busy = true
  ui.setBusy(true)
  ui.showChatLayout()
  ui.startBusyIndicator()
  transcript.addAssistantMessage(
    auto ? "Context window filling up — auto-compacting conversation…" : "Compacting conversation…",
  )
  ui.renderTranscript(transcript.entries, { scrollToBottom: true })

  const compactionController = new AbortController()
  activeTurn = compactionController

  try {
    const turnSession = await sessions.ensure()
    const result = await compactConversation(transcript.history, {
      client: activeClient,
      instructions,
      onUsage: async (usage) => {
        await turnSession.recordUsage(usage, "compaction")
      },
      signal: compactionController.signal,
    })
    const keptToolActivities = transcript.toolActivitiesFor(result.keptMessages)

    await turnSession.compact(result.summary, result.keptMessages, keptToolActivities)

    transcript.loadCompacted(result.summary, result.keptMessages, keptToolActivities)
    sessions.refreshLabel()
    updateContextIndicator()
    ui.renderTranscript(transcript.entries, { scrollToBottom: true })
  } catch (error) {
    if (compactionController.signal.aborted) return
    ui.showChatLayout()
    transcript.addAssistantMessage(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`)
    ui.renderTranscript(transcript.entries, { scrollToBottom: true })
  } finally {
    if (activeTurn === compactionController) activeTurn = undefined
    busy = false
    ui.setBusy(false)
    ui.stopBusyIndicator()
    if (!exiting) ui.focusInput()
  }
}

function quit() {
  exiting = true
  updateCheckController?.abort()
  activeTurn?.abort()
  renderer.destroy()
}

async function refreshLocalStats() {
  try {
    const stats = await calculateLocalStats()
    if (!exiting) ui.setStats(stats)
  } catch {
    // A damaged or temporarily unavailable local stats file must not block the CLI.
  }
}

function applySelectedModel(model: FireworksModel) {
  selectedModelId = model.id
  autoCompactAtTokens = autoCompactThreshold(model.contextLength)
  if (fireworksApiKey) client = new FireworksClient({ apiKey: fireworksApiKey, model: model.id })
  ui.setModelLabel(formatModelName(model.displayName))
  updateContextIndicator()
}

function updateContextIndicator(pendingInput = "") {
  const usage = contextUsage(
    estimateContextTokens(transcript.history, projectContextChars, pendingInput),
    autoCompactAtTokens,
  )
  ui.setContextLabel(formatContextUsage(usage), contextUsageColor(usage.percent))
}

function toggleMode() {
  if (busy) return
  permissionMode = permissionMode === "ask" ? "auto" : "ask"
  ui.setModeLabel(formatModeLabel(permissionMode))
}

async function selectThemeCommand(value: string) {
  const theme = value.slice("/theme".length).trim()
  if (!isThemeName(theme)) {
    showThemeMessage("Choose a theme with `/theme`.")
    return
  }

  try {
    await saveSelectedTheme(theme)
    selectedTheme = theme
    previewTheme(theme)
    ui.clearInput()
    ui.focusInput()
  } catch (error) {
    previewTheme(selectedTheme)
    showThemeMessage(`Could not save theme: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function previewTheme(theme: ThemeName) {
  const previous = selectTheme(theme)
  ui.setTheme(theme, previous)
}

async function setThinkingVisible(visible: boolean) {
  const previous = thinkingVisible
  thinkingVisible = visible
  ui.setThinkingVisible(visible)
  ui.clearInput()
  ui.focusInput()
  try {
    await saveThinkingVisible(visible)
  } catch (error) {
    thinkingVisible = previous
    ui.setThinkingVisible(previous)
    transcript.addDebugMessage(
      `Could not save thinking visibility: ${error instanceof Error ? error.message : String(error)}`,
    )
    ui.renderTranscript(transcript.entries, { scrollToBottom: true })
  }
}

function showThemeMessage(message: string) {
  ui.showChatLayout()
  transcript.addAssistantMessage(message)
  ui.clearInput()
  ui.renderTranscript(transcript.entries)
  ui.focusInput()
}

function handlePermissionRequest(request: PermissionRequest): Promise<boolean> {
  const activity = describeToolCall(request.call)
  return ui.showPermissionPrompt(activity.label)
}

function formatModeLabel(mode: PermissionMode) {
  if (mode === "ask") return "? ask"
  if (mode === "auto") return "› auto"
  return "× dontAsk"
}

function formatModelName(model: string | undefined) {
  if (!model) return ""
  return model.includes("/") ? (model.split("/").at(-1) ?? model) : model
}
