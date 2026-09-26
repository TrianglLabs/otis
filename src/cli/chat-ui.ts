import { spawn } from "node:child_process"
import { platform } from "node:os"
import {
  type BoxRenderable,
  fg,
  MouseButton,
  type RGBA,
  rgbToHex,
  ScrollBoxRenderable,
  StyledText,
  t,
} from "@opentui/core"
import type { SubagentTrace } from "../app/subagents.js"
import { isThemeName, THEME_NAMES, type ThemeName } from "../local/settings.js"
import { colors, type ThemeColors } from "./theme.js"
import { AgentStatus } from "./ui/agent-status.js"
import { CommandMenu } from "./ui/command-menu.js"
import { CHAT_KEY_HINT, CHAT_KEY_HINT_DURATION_MS, formatContextLabel } from "./ui/format.js"
import { HomeStats } from "./ui/home-stats.js"
import { InputController } from "./ui/input-controller.js"
import { createUILayout, setTopBarSideMinWidth, setWelcomePanelExpanded } from "./ui/layout.js"
import { ModelPicker } from "./ui/model-picker.js"
import { createScrollbarOptions } from "./ui/panels.js"
import { SessionPicker } from "./ui/session-picker.js"
import { SubagentPanel } from "./ui/subagent-panel.js"
import { SubagentTraceView } from "./ui/subagent-trace-view.js"
import { TranscriptView } from "./ui/transcript-view.js"
import {
  type ChatUI,
  type ChatUIOptions,
  type CommandSuggestion,
  type ModelPickerItem,
  type Renderer,
  type SessionPickerItem,
  stopKey,
  type UIKey,
} from "./ui/types.js"

export function createChatUI(renderer: Renderer, options: ChatUIOptions): ChatUI {
  let showingWelcome = true
  let busy = false
  let updateHintVisible = false
  let activeTheme: ThemeName = options.theme ?? "default"
  let selectedModelName = options.modelLabel
  let sessionTitle = options.sessionLabel
  let backgroundWorking = 0
  let diffAdded = 0
  let diffRemoved = 0
  let subagentTraces: readonly SubagentTrace[] = []
  let commandMenuVisible = false
  let submenuOpen = false
  let submenuBack: (() => void) | undefined
  let modelPickerVisible = false
  let sessionPickerVisible = false
  let permissionVisible = false
  let resolvePermission: ((approved: boolean) => void) | undefined

  const layout = createUILayout(renderer, options)
  const {
    agentBar,
    chatBody,
    commandMenu,
    contextLabel,
    input,
    inputArea,
    inputBox,
    inputHint,
    attachments,
    messages,
    modelPanel,
    modelRowsBox,
    modeLabel,
    permissionLabel,
    permissionPrompt,
    root,
    sessionLabel,
    sessionPanel,
    sessionRowsBox,
    setupInput,
    statBoxes,
    statsRow,
    subagentPanel,
    subagentPanelFooter,
    subagentRowsBox,
    topBar,
    topBarEnd,
    topBarStart,
    updateHint,
    welcome,
    welcomePanel,
  } = layout
  const commands = new CommandMenu(renderer, commandMenu, options.commands ?? [])
  const models = new ModelPicker(renderer, modelRowsBox)
  const sessions = new SessionPicker(renderer, sessionRowsBox)
  const thinkingVisible = options.thinkingVisible ?? false
  const transcriptView = new TranscriptView(
    renderer,
    messages,
    options.treeSitterClient,
    thinkingVisible,
  )
  const traceView = new SubagentTraceView(renderer, options.treeSitterClient, thinkingVisible)
  const subagents = new SubagentPanel({
    renderer,
    chatBody,
    panel: subagentPanel,
    rows: subagentRowsBox,
    footer: subagentPanelFooter,
    onSelect: openSubagentTrace,
  })
  subagents.setVisible(options.subagentPanelVisible ?? true)
  const status = new AgentStatus({
    renderer,
    root,
    inputArea,
    agentBar,
    inputHint,
    isWelcomeVisible: () => showingWelcome,
    isOverlayVisible: () => commandMenuVisible || permissionVisible,
    onInterrupt: options.onInterrupt,
  })
  const homeStats = new HomeStats({ renderer, statBoxes, isWelcomeVisible: () => showingWelcome })
  refreshInputHint()
  const inputController = new InputController({
    renderer,
    layout,
    configured: options.configured !== false,
    localInferenceUnavailableReason: options.localInferenceUnavailableReason,
    onBeforePrimaryInput: () => hideCommandMenu(),
    onModeChange: (mode) =>
      setWelcomePanelExpanded(
        welcomePanel,
        mode === "setupChoice" || mode === "setupLocalChoice" || mode === "setupPairInput",
      ),
    onSetup: options.onSetup,
    onSetupInferenceChoice: options.onSetupInferenceChoice,
    onSetupLocalInferenceChoice: options.onSetupLocalInferenceChoice,
    onSetupSubmit: options.onSetupSubmit,
    onPairSetupSubmit: options.onPairSetupSubmit,
  })

  input.onSubmit = () => {
    if (inputController.mode !== "chat") return
    const value = input.plainText
    if (commandMenuVisible) {
      const selected = commands.selected()
      hideCommandMenu(false)
      selectCommand(selected, value.trim())
      return
    }
    closeSubagentTrace()
    options.onSubmit(value.trim())
  }

  input.onContentChange = () => {
    if (inputController.mode !== "chat") return
    const value = input.plainText
    if (submenuOpen && value === "") {
      options.onInputChange?.(value)
      return
    }
    updateCommandMenu(value)
    if (value !== "") subagents.blur()
    options.onInputChange?.(value)
  }

  inputHint.onMouseDown = (event) => {
    if (showingWelcome || event.button !== MouseButton.LEFT) return
    event.preventDefault()
    event.stopPropagation()
    status.showTransientHint(CHAT_KEY_HINT, CHAT_KEY_HINT_DURATION_MS)
  }
  inputHint.onMouseOver = () => {
    if (!showingWelcome) renderer.setMousePointer("pointer")
  }
  inputHint.onMouseOut = () => renderer.setMousePointer("default")

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && !key.meta && key.name === "c") {
      stopKey(key)
      void options.onQuit?.()
      return
    }
    if (inputController.handleKey(key)) return
    if (handlePermissionKey(key)) return
    if (handleOverlayKey(key)) return
    if (inputController.mode !== "chat") return

    if (subagents.mounted && subagents.focused) {
      if (subagents.handleKey(key)) return
    } else if (
      subagents.mounted &&
      input.plainText === "" &&
      (key.name === "right" || key.name === "up" || key.name === "down")
    ) {
      stopKey(key)
      subagents.focus()
      if (key.name !== "right" && traceView.trace) subagents.handleKey(key)
      return
    }

    if (key.name === "escape") {
      stopKey(key)
      if (traceView.trace) {
        closeSubagentTrace()
        subagents.blur()
        return
      }
      if (subagents.focused) {
        subagents.blur()
        return
      }
      if (busy) status.handleEscape()
      return
    }

    if (key.name === "left" && input.plainText === "" && (traceView.trace || subagents.focused)) {
      stopKey(key)
      closeSubagentTrace()
      subagents.blur()
      return
    }

    if (key.name === "backspace" && input.plainText === "" && options.onRemoveLastAttachment?.()) {
      stopKey(key)
      return
    }

    if (key.name !== "tab" && key.sequence !== "\t") return

    stopKey(key)
    options.onToggleMode?.()
    focusInput()
  })

  renderer.keyInput.on("paste", (event) => {
    if (inputController.mode !== "chat") return
    const mimeType = event.metadata?.mimeType
    if (event.metadata?.kind === "binary" || mimeType?.toLowerCase().startsWith("image/")) {
      event.preventDefault()
      event.stopPropagation()
      void options.onImagePaste?.(event.bytes, mimeType)
      return
    }
    const text = new TextDecoder().decode(event.bytes)
    if (!options.onAttachmentPathPaste?.(text)) return
    event.preventDefault()
    event.stopPropagation()
  })

  renderer.on("selection", (selection) => {
    const text = selection.getSelectedText().trim()
    if (!text) return
    const osc52Ok = renderer.copyToClipboardOSC52(text)
    renderer.clearSelection()
    if (osc52Ok) status.showTransientHint(" Copied! ")
    else {
      copyToClipboardNative(text).then((nativeOk) => {
        if (nativeOk) status.showTransientHint(" Copied! ")
      })
    }
  })

  function refreshInputHint(welcome = showingWelcome) {
    if (welcome) status.setInputHint(selectedModelName ? ` ${selectedModelName} ` : "")
    else
      status.setInputHint(
        ` ${selectedModelName || "No model selected"} · ${options.workspaceLabel} `,
      )
  }

  function renderSubagents(traces: readonly SubagentTrace[]) {
    subagentTraces = traces
    subagents.render(traces)
    const wasOpen = traceView.trace !== undefined
    traceView.update(traces)
    if (wasOpen && !traceView.trace) {
      // The open run left the session (e.g. a session switch); fall back to the conversation.
      swapChatBodyChild(traceView.root, messages)
      subagents.select(undefined)
    }
  }

  function openSubagentTrace(toolCallId: string) {
    const trace = subagentTraces.find((candidate) => candidate.toolCallId === toolCallId)
    if (!trace || showingWelcome) return
    hideCommandMenu()
    // The trace takes the transcript's slot so pickers on the left and the run list on the right
    // stay put.
    if (!traceView.trace) swapChatBodyChild(messages, traceView.root)
    traceView.open(trace)
    subagents.select(toolCallId)
  }

  function closeSubagentTrace() {
    if (!traceView.trace) return
    swapChatBodyChild(traceView.root, messages)
    traceView.close()
    subagents.select(undefined)
  }

  function swapChatBodyChild(from: { id: string }, to: BoxRenderable | ScrollBoxRenderable) {
    const slot = chatBody.getChildren().findIndex((child) => child.id === from.id)
    chatBody.remove(from.id)
    chatBody.add(to, slot)
  }

  function showChatLayout() {
    if (!showingWelcome) return
    refreshInputHint(false)
    Object.assign(inputBox, { width: "100%", maxWidth: undefined, minWidth: 1 })
    inputArea.backgroundColor = colors.background
    inputArea.marginTop = 1
    inputArea.paddingRight = 1
    welcomePanel.remove(inputArea.id)
    root.remove(welcome.id)
    root.add(topBar)
    chatBody.add(messages, 0)
    root.add(chatBody)
    root.add(inputArea)
    showingWelcome = false
    homeStats.settle()
    renderer.requestRender()
  }

  function showHomeLayout() {
    if (showingWelcome) return
    hideCommandMenu()
    dismissSessionPicker()
    dismissModelPicker()
    status.hideForHome()
    refreshInputHint(true)
    Object.assign(inputBox, { width: "100%", maxWidth: undefined, minWidth: 24 })
    inputArea.marginTop = 0
    inputArea.paddingRight = 0
    closeSubagentTrace()
    root.remove(topBar.id)
    root.remove(chatBody.id)
    root.remove(inputArea.id)
    chatBody.remove(messages.id)
    welcomePanel.add(inputArea, 0)
    root.add(welcome)
    showingWelcome = true
    homeStats.replay()
    renderer.requestRender()
  }

  function clearInput() {
    inputController.clear()
    hideCommandMenu()
  }

  function focusInput() {
    inputController.focus()
  }

  function handleOverlayKey(key: UIKey) {
    if (commandMenuVisible) {
      const handled = commands.handleKey(key, {
        close: (restoreThemePreview) => {
          if (key.name === "escape" && submenuBack) {
            const back = submenuBack
            submenuBack = undefined
            back()
            return
          }
          hideCommandMenu(restoreThemePreview)
        },
        select: (command) => selectCommand(command, command.name),
        preview: (command) => {
          const theme = themeFromCommand(command.name)
          if (theme) options.onPreviewTheme?.(theme)
        },
      })
      if (handled && key.name === "escape") focusInput()
      if (handled) return true
    }
    if (
      modelPickerVisible &&
      models.handleKey(key, {
        close: () => {
          hideModelPicker()
          options.onCloseModelPicker?.()
        },
        select: (model) => options.onSelectModel?.(model),
      })
    ) {
      return true
    }
    return (
      sessionPickerVisible &&
      sessions.handleKey(key, {
        close: hideSessionPicker,
        create: () => options.onNewSession?.(),
        delete: (sessionId) => options.onDeleteSession?.(sessionId),
        select: (sessionId) => options.onSelectSession?.(sessionId),
      })
    )
  }

  function selectCommand(command: CommandSuggestion | undefined, fallback: string) {
    if (command?.draft !== undefined) {
      input.setText(command.draft)
      options.onInputChange?.(command.draft)
      inputController.focus()
      return
    }
    if (command?.name === "/theme") {
      clearInput()
      showThemeMenu()
      focusInput()
      return
    }
    options.onSubmit(command?.submission ?? command?.name ?? fallback)
  }

  function updateCommandMenu(value: string) {
    submenuOpen = false
    submenuBack = undefined
    if (commands.update(value, showingWelcome, activeTheme)) showCommandMenu()
    else hideCommandMenu()
  }

  function showThemeMenu() {
    showCommandSubmenu(
      THEME_NAMES.map((theme) => ({
        name: theme,
        description: theme === activeTheme ? "Active" : "",
        submission: `/settings theme ${theme}`,
      })),
    )
  }

  function showCommandSubmenu(
    items: readonly CommandSuggestion[],
    submenuOptions: { onBack?: () => void } = {},
  ) {
    submenuOpen = true
    submenuBack = submenuOptions.onBack
    commands.showSubmenu(items)
    commands.refreshTheme(activeTheme)
    showCommandMenu()
  }

  function showCommandMenu() {
    if (!commandMenuVisible) {
      status.suspendForOverlay()
      inputArea.add(commandMenu)
      commandMenuVisible = true
    }
    renderer.requestRender()
  }

  function hideCommandMenu(restoreThemePreview = true) {
    if (!commandMenuVisible) return
    inputArea.remove(commandMenu.id)
    commandMenuVisible = false
    submenuOpen = false
    submenuBack = undefined
    commands.clear()
    if (restoreThemePreview) options.onCancelThemePreview?.()
    status.restoreAfterOverlay()
    renderer.requestRender()
  }

  function showSessionPicker(items: SessionPickerItem[]) {
    showChatLayout()
    dismissModelPicker()
    models.stop()
    sessions.setItems(items)
    if (!sessionPickerVisible) {
      chatBody.add(sessionPanel, 0)
      sessionPickerVisible = true
    }
    renderer.requestRender()
  }

  function showModelPicker(items: ModelPickerItem[]) {
    inputController.hideSetupStatus()
    showChatLayout()
    dismissSessionPicker()
    models.setItems(items)
    if (!modelPickerVisible) {
      chatBody.add(modelPanel, 0)
      modelPickerVisible = true
    }
    renderer.requestRender()
  }

  function hideModelPicker() {
    if (!modelPickerVisible) return
    dismissModelPicker()
    focusInput()
    renderer.requestRender()
  }

  function hideSessionPicker() {
    if (!sessionPickerVisible) return
    dismissSessionPicker()
    focusInput()
    renderer.requestRender()
  }

  function dismissModelPicker() {
    if (!modelPickerVisible) return
    models.stop()
    chatBody.remove(modelPanel.id)
    modelPickerVisible = false
  }

  function dismissSessionPicker() {
    if (!sessionPickerVisible) return
    sessions.stop()
    chatBody.remove(sessionPanel.id)
    sessionPickerVisible = false
  }

  function showPermissionPrompt(detail: string): Promise<boolean> {
    permissionLabel.content = detail
    if (!permissionVisible) {
      inputArea.add(permissionPrompt)
      permissionVisible = true
    }
    renderer.requestRender()
    const decision = new Promise<boolean>((resolve) => {
      resolvePermission = resolve
    })
    status.suspendForOverlay()
    return decision.finally(() => status.restoreAfterOverlay())
  }

  function finishPermission(approved: boolean) {
    const resolve = resolvePermission
    if (permissionVisible) {
      inputArea.remove(permissionPrompt.id)
      permissionVisible = false
      renderer.requestRender()
    }
    resolvePermission = undefined
    resolve?.(approved)
  }

  function handlePermissionKey(key: UIKey) {
    if (!permissionVisible) return false
    if (key.name === "y") {
      stopKey(key)
      finishPermission(true)
      return true
    }
    if (key.name === "n" || key.name === "escape") {
      stopKey(key)
      finishPermission(false)
      return true
    }
    return false
  }

  function renderSessionLabel() {
    const label =
      diffAdded > 0 || diffRemoved > 0
        ? t`${sessionTitle}  ${fg(colors.green)(`+${diffAdded}`)} ${fg(colors.pink)(`−${diffRemoved}`)}`
        : t`${sessionTitle}`
    const working = t` ${fg(colors.muted)(`· ${backgroundWorking} working`)}`
    sessionLabel.content =
      backgroundWorking > 0 ? new StyledText([...label.chunks, ...working.chunks]) : label
    renderer.requestRender()
  }

  function setAttachmentCounts(images: number, documents: number) {
    const labels = [
      ...Array.from({ length: Math.min(images, 2) }, (_, index) => `[Image ${index + 1}]`),
      ...Array.from(
        { length: Math.min(documents, Math.max(0, 2 - images)) },
        (_, index) => `[File ${index + 1}]`,
      ),
    ]
    const total = images + documents
    if (total > labels.length) labels.push(`+${total - labels.length}`)
    attachments.content = labels.join(" ")
    const mounted = inputBox.getChildren().some((child) => child.id === attachments.id)
    if (total > 0 && !mounted) inputBox.add(attachments, 1)
    if (total === 0 && mounted) inputBox.remove(attachments.id)
    renderer.requestRender()
  }

  function setTheme(theme: ThemeName, previous: ThemeColors) {
    activeTheme = theme
    recolorTree(
      [...Object.values<unknown>(layout).filter(isRenderableTree), traceView.root],
      previous,
    )
    input.focusedBackgroundColor = colors.background
    input.focusedTextColor = colors.text
    setupInput.focusedBackgroundColor = colors.background
    setupInput.focusedTextColor = colors.text
    // recolorTree cannot reach scrollbar slider colors; restyle them directly.
    for (const box of [messages, sessionRowsBox, modelRowsBox, subagentRowsBox]) {
      box.verticalScrollbarOptions = createScrollbarOptions()
    }
    renderer.setBackgroundColor(colors.background)
    status.refreshTheme(previous)
    transcriptView.refreshTheme()
    traceView.refreshTheme()
    subagents.refreshTheme()
    if (commandMenuVisible) commands.refreshTheme(activeTheme)
    renderer.requestRender()
  }

  function setContextLabel(label: string, color = colors.muted) {
    const padded = formatContextLabel(label)
    contextLabel.content = padded
    contextLabel.fg = color
    setTopBarSideMinWidth(topBarStart, topBarEnd, padded)
    status.setContextColor(color)
    renderer.requestRender()
  }

  function showUpdateHint() {
    updateHint.content = "New update available — run `otis update`"
    updateHint.fg = colors.yellow
    if (!updateHintVisible) {
      welcomePanel.add(updateHint)
      updateHintVisible = true
    }
    renderer.requestRender()
  }

  function hideUpdateHint() {
    if (!updateHintVisible) return
    welcomePanel.remove(updateHint.id)
    updateHintVisible = false
    renderer.requestRender()
  }

  function showStats() {
    if (!welcome.getChildren().some((child) => child.id === statsRow.id))
      welcome.insertBefore(statsRow, welcomePanel)
    renderer.requestRender()
  }

  focusInput()

  return {
    clearInput,
    focusInput,
    hidePermissionPrompt: () => {
      finishPermission(false)
      status.restoreAfterOverlay()
    },
    hideModelPicker,
    hideSessionPicker,
    hideUpdateHint,
    renderTranscript: (entries, renderOptions) => transcriptView.render(entries, renderOptions),
    renderSubagents,
    setBusy: (value) => {
      busy = value
      if (!value) status.clearInterrupt()
    },
    setContextLabel,
    setDiffStats: (added, removed) => {
      diffAdded = added
      diffRemoved = removed
      renderSessionLabel()
    },
    setModeLabel: (label) => {
      modeLabel.content = label
      renderer.requestRender()
    },
    setAttachmentCounts,
    setModelLabel: (label) => {
      selectedModelName = label
      refreshInputHint()
    },
    setModelPickerStatus: (modelId, modelStatus) => models.setItemStatus(modelId, modelStatus),
    setCommands: (value) => commands.setCommands(value),
    setConfigured: () => {
      inputController.setConfigured()
      showStats()
    },
    setSessionLabel: (label) => {
      sessionTitle = label
      renderSessionLabel()
    },
    setBackgroundWorking: (count) => {
      backgroundWorking = count
      renderSessionLabel()
    },
    setStats: (stats) => homeStats.setStats(stats),
    setTheme,
    setThinkingVisible: (visible) => {
      transcriptView.setThinkingVisible(visible)
      traceView.setThinkingVisible(visible)
    },
    setSubagentPanelVisible: (visible) => {
      if (!visible) closeSubagentTrace()
      subagents.setVisible(visible)
    },
    showStats,
    showTransientHint: (content) => status.showTransientHint(content),
    showCommandSubmenu,
    showSlashCommandMenu: () => {
      input.setText("/")
      updateCommandMenu("/")
      options.onInputChange?.("/")
      inputController.focus()
    },
    showModelPicker,
    showSetupError: (message, cancelTarget) =>
      inputController.showSetup(message, cancelTarget, true),
    showSetupInferenceChoice: (message) => inputController.showSetupInferenceChoice(message),
    showSetupLocalInferenceChoice: (message) =>
      inputController.showSetupLocalInferenceChoice(message),
    showSetupInput: (message, cancelTarget) => inputController.showSetup(message, cancelTarget),
    showPairSetup: (message, cancelTarget, endpoints) =>
      inputController.showPairSetup(message, cancelTarget, endpoints),
    showPairSetupError: (message, cancelTarget, endpoints) =>
      inputController.showPairSetup(message, cancelTarget, endpoints, true),
    showSetupStatus: (message) => inputController.showSetupStatus(message),
    showPermissionPrompt,
    showSessionPicker,
    showThemeMenu,
    showChatLayout,
    showHomeLayout,
    showUpdateHint,
    setAgentPhase: (phase) => status.setPhase(phase),
    startBusyIndicator: () => status.startBusyIndicator(),
    stopBusyIndicator: () => status.stopBusyIndicator(),
  }
}

function themeFromCommand(command: string): ThemeName | undefined {
  if (isThemeName(command)) return command
  for (const prefix of ["/theme ", "/settings theme "]) {
    if (!command.startsWith(prefix)) continue
    const theme = command.slice(prefix.length)
    if (isThemeName(theme)) return theme
  }
  return undefined
}

type RenderableTree = { getChildren(): unknown[] }

function isRenderableTree(value: unknown): value is RenderableTree {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && "getChildren" in value
  )
}

const RECOLOR_KEYS = [
  "backgroundColor",
  "borderColor",
  "fg",
  "bg",
  "textColor",
  "cursorColor",
] as const

type RecolorNode = {
  getChildren?: () => unknown[]
  wrapper?: RecolorNode
  viewport?: RecolorNode
  content?: RecolorNode
} & Record<string, unknown>

/**
 * Swaps every color that matched the previous theme for the same slot in the current theme,
 * across a tree.
 */
function recolorTree(renderables: Iterable<RenderableTree>, previous: ThemeColors) {
  const replacements = new Map<string, string>()
  const visited = new WeakSet<object>()
  for (const key of Object.keys(previous) as (keyof ThemeColors)[]) {
    const oldHex = previous[key].toLowerCase()
    const newHex = colors[key]
    if (oldHex !== newHex.toLowerCase()) replacements.set(oldHex, newHex)
  }

  const visit = (current: RecolorNode | undefined) => {
    if (!current || visited.has(current)) return
    visited.add(current)
    for (const key of RECOLOR_KEYS) {
      const value = current[key]
      if (isColor(value)) {
        const replacement = replacements.get(rgbToHex(value).toLowerCase())
        if (replacement) current[key] = replacement
      } else if (typeof value === "string") {
        const replacement = replacements.get(value.toLowerCase())
        if (replacement && replacement.toLowerCase() !== value.toLowerCase())
          current[key] = replacement
      }
    }
    if (current instanceof ScrollBoxRenderable) {
      visit(current.wrapper)
      visit(current.viewport)
      visit(current.content)
    }
    for (const child of current.getChildren?.() ?? []) visit(child as RecolorNode)
  }
  for (const renderable of renderables) visit(renderable as RecolorNode)
}

function isColor(value: unknown): value is RGBA {
  return (
    typeof value === "object" &&
    value !== null &&
    "toInts" in value &&
    typeof value.toInts === "function"
  )
}

let clipboardCommand: Promise<string[] | undefined> | undefined

async function resolveClipboardCommand() {
  const os = platform()
  const exists = (name: string) =>
    new Promise<boolean>((resolve) => {
      const child = spawn(os === "win32" ? "where" : "which", [name], { stdio: "ignore" })
      child.on("error", () => resolve(false))
      child.on("exit", (code) => resolve(code === 0))
    })
  if (os === "darwin" && (await exists("pbcopy"))) return ["pbcopy"]
  if (os === "linux") {
    if (process.env.WAYLAND_DISPLAY && (await exists("wl-copy"))) return ["wl-copy"]
    if (await exists("xclip")) return ["xclip", "-selection", "clipboard"]
    if (await exists("xsel")) return ["xsel", "--clipboard", "--input"]
  }
  if (os === "win32" && (await exists("powershell.exe"))) {
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ]
  }
  return undefined
}

/**
 * Copies through a native platform utility, which unlike OSC 52 has no size limit. The command
 * is resolved once and cached; resolves false when no native clipboard tool exists so the caller
 * stays on OSC 52.
 */
async function copyToClipboardNative(text: string) {
  clipboardCommand ??= resolveClipboardCommand()
  const cmd = await clipboardCommand
  if (!cmd) return false
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => resolve(false))
    child.on("exit", (code) => resolve(code === 0))
    child.stdin?.on("error", () => resolve(false))
    child.stdin?.end(text)
  })
}
