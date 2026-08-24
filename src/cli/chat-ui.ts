import { MouseButton, type TextRenderable } from "@opentui/core"
import type { ThemeName } from "../local/settings.js"
import type { LocalStats } from "../local/stats.js"
import { copyToClipboardNative } from "./clipboard.js"
import { colors, type ThemeColors } from "./theme.js"
import type { TranscriptEntry } from "./transcript.js"
import { AgentStatus } from "./ui/agent-status.js"
import { CommandMenu } from "./ui/command-menu.js"
import {
  type AgentPhase,
  CHAT_INPUT_HINT,
  formatContextLabel,
  formatRuntimeHint,
  imageAttachmentLabel,
} from "./ui/format.js"
import { HomeStats } from "./ui/home-stats.js"
import { InputController } from "./ui/input-controller.js"
import { createUILayout, themeRootsFrom } from "./ui/layout.js"
import { ModelPicker } from "./ui/model-picker.js"
import { OverlayHost } from "./ui/overlays.js"
import { createScrollbarOptions } from "./ui/panels.js"
import { PermissionController } from "./ui/permission-controller.js"
import { recolorTree } from "./ui/recolor.js"
import { SessionPicker } from "./ui/session-picker.js"
import { SessionStatus } from "./ui/session-status.js"
import { TranscriptView } from "./ui/transcript-view.js"
import type { ChatUI, ChatUIOptions, Renderer } from "./ui/types.js"

export type { ChatUI, CommandSuggestion, ModelPickerItem, SessionPickerItem } from "./ui/types.js"

export function createChatUI(renderer: Renderer, options: ChatUIOptions): ChatUI {
  let showingWelcome = true
  let busy = false
  let updateHintVisible = false
  let activeTheme = options.theme ?? "default"
  let selectedModelName = options.modelLabel
  let runtimeHintVisible = false

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
    imageAttachments,
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
    setupButtonBox,
    setupContinueButton,
    setupForm,
    setupInput,
    setupInputLabel,
    setupMessage,
    setupStartButton,
    setupStatus,
    setupStatusBox,
    statBoxes,
    statsRow,
    topBar,
    updateHint,
    welcome,
    welcomePanel,
    welcomeQuit,
  } = layout
  const commands = new CommandMenu(renderer, commandMenu, options.commands ?? [])
  const models = new ModelPicker(renderer, modelRowsBox)
  const sessions = new SessionPicker(renderer, sessionRowsBox)
  const sessionStatus = new SessionStatus(renderer, sessionLabel, options.sessionLabel)
  const transcriptView = new TranscriptView(
    renderer,
    messages,
    options.treeSitterClient,
    options.thinkingVisible ?? false,
  )
  const permissions = new PermissionController({
    renderer,
    inputArea,
    prompt: permissionPrompt,
    label: permissionLabel,
  })
  let overlays: OverlayHost
  const status = new AgentStatus({
    renderer,
    root,
    inputArea,
    agentBar,
    inputHint,
    isWelcomeVisible: () => showingWelcome,
    isOverlayVisible: () => overlays.commandMenuVisible || permissions.isVisible,
    onInterrupt: options.onInterrupt,
  })
  const homeStats = new HomeStats({
    renderer,
    statBoxes,
    isWelcomeVisible: () => showingWelcome,
  })
  status.setInputHint(homeModelHint(selectedModelName))
  const inputController = new InputController({
    renderer,
    configured: options.configured !== false,
    input,
    inputArea,
    inputBox,
    setupButtonBox,
    setupContinueButton,
    setupForm,
    setupInput,
    setupInputLabel,
    setupMessage,
    setupStartButton,
    setupStatus,
    setupStatusBox,
    welcomeQuit,
    onBeforePrimaryInput: () => overlays.hideCommandMenu(),
    onSetup: options.onSetup,
    onSetupSubmit: options.onSetupSubmit,
  })
  overlays = new OverlayHost({
    renderer,
    chatBody,
    inputArea,
    commandMenu,
    modelPanel,
    sessionPanel,
    commands,
    models,
    sessions,
    showingWelcome: () => showingWelcome,
    activeTheme: () => activeTheme,
    onSubmit: options.onSubmit,
    onPreviewTheme: options.onPreviewTheme,
    onCancelThemePreview: options.onCancelThemePreview,
    onCloseModelPicker: options.onCloseModelPicker,
    onSelectModel: options.onSelectModel,
    onNewSession: options.onNewSession,
    onDeleteSession: options.onDeleteSession,
    onSelectSession: options.onSelectSession,
    showChatLayout,
    hideSetupStatus: () => inputController.hideSetupStatus(),
    clearInput,
    focusInput,
    suspendStatus: () => status.suspendForOverlay(),
    restoreStatus: () => status.restoreAfterOverlay(),
  })

  input.onSubmit = () => {
    if (inputController.mode !== "chat") return
    const value = input.plainText
    if (overlays.submitFromInput(value)) return
    overlays.hideCommandMenu()
    options.onSubmit(value.trim())
  }

  input.onContentChange = () => {
    if (inputController.mode !== "chat") return
    const value = input.plainText
    if (overlays.themeMenuOpen && value === "") {
      options.onInputChange?.(value)
      return
    }
    overlays.updateCommandMenu(value)
    options.onInputChange?.(value)
  }

  inputHint.onMouseDown = (event) => {
    if (showingWelcome || event.button !== MouseButton.LEFT) return
    event.preventDefault()
    event.stopPropagation()
    runtimeHintVisible = !runtimeHintVisible
    status.setInputHint(chatInputHint())
  }
  inputHint.onMouseOver = () => {
    if (!showingWelcome) renderer.setMousePointer("pointer")
  }
  inputHint.onMouseOut = () => renderer.setMousePointer("default")

  renderer.keyInput.on("keypress", (key) => {
    if (inputController.handleKey(key)) return
    if (permissions.handleKey(key)) return
    if (overlays.handleKey(key)) return
    if (inputController.mode !== "chat") return

    if (key.name === "escape") {
      stopKey(key)
      if (busy) status.handleEscape()
      return
    }

    if (key.name === "backspace" && input.plainText === "" && options.onRemoveLastImage?.()) {
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
    if (!options.onImagePathPaste?.(text)) return
    event.preventDefault()
    event.stopPropagation()
  })

  renderer.on("selection", (selection) => {
    const text = selection.getSelectedText().trim()
    if (!text) return
    const osc52Ok = renderer.copyToClipboardOSC52(text)
    renderer.clearSelection()
    if (osc52Ok) {
      status.showCopyHint()
    } else {
      copyToClipboardNative(text).then((nativeOk) => {
        if (nativeOk) status.showCopyHint()
      })
    }
  })

  function renderTranscript(entries: TranscriptEntry[], renderOptions: { scrollToBottom?: boolean } = {}) {
    transcriptView.render(entries, renderOptions)
  }

  function setThinkingVisible(visible: boolean) {
    transcriptView.setThinkingVisible(visible)
  }

  function showChatLayout() {
    if (!showingWelcome) return
    runtimeHintVisible = false
    status.setInputHint(chatInputHint())

    root.live = false
    Object.assign(inputBox, {
      width: "100%",
      maxWidth: undefined,
      minWidth: 1,
    })
    inputArea.backgroundColor = colors.background
    inputArea.marginTop = 1
    inputArea.paddingRight = 1
    welcomePanel.remove(inputArea.id)
    root.remove(welcome.id)
    root.add(topBar)
    chatBody.add(messages)
    root.add(chatBody)
    root.add(inputArea)
    showingWelcome = false
    homeStats.settle()
    renderer.requestRender()
  }

  function showHomeLayout() {
    if (showingWelcome) return

    overlays.hideCommandMenu()
    overlays.dismissPickers()
    status.hideForHome()
    runtimeHintVisible = false
    status.setInputHint(homeModelHint(selectedModelName))

    root.live = true
    Object.assign(inputBox, {
      width: "100%",
      maxWidth: undefined,
      minWidth: 24,
    })
    inputArea.marginTop = 0
    inputArea.paddingRight = 0
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
    overlays.hideCommandMenu()
  }

  function setImageAttachmentCount(count: number) {
    setText(imageAttachments, imageAttachmentLabel(count))
    const mounted = inputBox.getChildren().some((child) => child.id === imageAttachments.id)
    if (count > 0 && !mounted) inputBox.add(imageAttachments, 1)
    if (count === 0 && mounted) inputBox.remove(imageAttachments.id)
    renderer.requestRender()
  }

  function setTheme(theme: ThemeName, previous: ThemeColors) {
    activeTheme = theme
    recolorTree(themeRootsFrom(layout), previous)
    input.focusedBackgroundColor = colors.background
    input.focusedTextColor = colors.text
    setupInput.focusedBackgroundColor = colors.background
    setupInput.focusedTextColor = colors.text
    // recolorTree cannot reach scrollbar slider colors; restyle them directly.
    messages.verticalScrollbarOptions = createScrollbarOptions()
    sessionRowsBox.verticalScrollbarOptions = createScrollbarOptions()
    modelRowsBox.verticalScrollbarOptions = createScrollbarOptions()
    renderer.setBackgroundColor(colors.background)
    status.refreshTheme(previous)
    transcriptView.refreshTheme()
    overlays.refreshTheme()
    renderer.requestRender()
  }

  function focusInput() {
    inputController.focus()
  }

  function setConfigured() {
    inputController.setConfigured()
    showStats()
  }

  function setContextLabel(label: string, color = colors.muted) {
    setText(contextLabel, formatContextLabel(label))
    contextLabel.fg = color
    status.setContextColor(color)
    renderer.requestRender()
  }

  function setModeLabel(label: string) {
    setText(modeLabel, label)
    renderer.requestRender()
  }

  function setModelLabel(label: string) {
    selectedModelName = label
    if (showingWelcome) status.setInputHint(homeModelHint(selectedModelName))
    else status.setInputHint(chatInputHint())
  }

  function chatInputHint() {
    return runtimeHintVisible ? formatRuntimeHint(selectedModelName, options.workspaceLabel) : CHAT_INPUT_HINT
  }

  function showPermissionPrompt(detail: string): Promise<boolean> {
    const decision = permissions.show(detail)
    status.suspendForOverlay()
    return decision.finally(() => status.restoreAfterOverlay())
  }

  function hidePermissionPrompt() {
    permissions.hide()
    status.restoreAfterOverlay()
  }

  function setBusy(value: boolean) {
    busy = value
    if (!value) status.clearInterrupt()
  }

  function showUpdateHint() {
    setText(updateHint, "New update available — run `otis update`")
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

  function setStats(stats: LocalStats) {
    homeStats.setStats(stats)
  }

  function showStats() {
    if (!welcome.getChildren().some((child) => child.id === statsRow.id)) welcome.insertBefore(statsRow, welcomePanel)
    renderer.requestRender()
  }

  focusInput()

  return {
    clearInput,
    focusInput,
    hidePermissionPrompt,
    hideModelPicker: () => overlays.hideModelPicker(),
    hideSessionPicker: () => overlays.hideSessionPicker(),
    hideUpdateHint,
    renderTranscript,
    setBusy,
    setContextLabel,
    setDiffStats: (added, removed) => sessionStatus.setDiff(added, removed),
    setModeLabel,
    setImageAttachmentCount,
    setModelLabel,
    setCommands: (value) => commands.setCommands(value),
    setConfigured,
    setSessionLabel: (label) => sessionStatus.setLabel(label),
    setStats,
    setTheme,
    setThinkingVisible,
    showStats,
    showTransientHint: (content) => status.showTransientHint(content),
    showModelPicker: (items) => overlays.showModelPicker(items),
    showSetupError: (message) => inputController.showSetupError(message),
    showSetupButton: () => inputController.showSetupButton(),
    showSetupInput: (message) => inputController.showSetup(message),
    showSetupStatus: (message) => inputController.showSetupStatus(message),
    showPermissionPrompt,
    showSessionPicker: (items) => overlays.showSessionPicker(items),
    showThemeMenu: () => overlays.showThemeMenu(),
    showChatLayout,
    showHomeLayout,
    showUpdateHint,
    setAgentPhase: (phase: AgentPhase) => status.setPhase(phase),
    startBusyIndicator: () => status.startBusyIndicator(),
    stopBusyIndicator: () => status.stopBusyIndicator(),
  }
}

function homeModelHint(modelName: string) {
  return modelName ? ` ${modelName} ` : ""
}

function setText(renderable: TextRenderable, content: string) {
  renderable.content = content
}

function stopKey(key: { preventDefault(): void; stopPropagation(): void }) {
  key.preventDefault()
  key.stopPropagation()
}
