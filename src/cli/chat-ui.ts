import type { TextRenderable } from "@opentui/core"
import type { LocalStats } from "../local/stats.js"
import { copyToClipboardNative } from "./clipboard.js"
import { colors } from "./theme.js"
import type { TranscriptEntry } from "./transcript.js"
import { AgentStatus } from "./ui/agent-status.js"
import { CommandMenu } from "./ui/command-menu.js"
import { ESC_INTERRUPT_HINT, formatContextLabel, formatStats } from "./ui/format.js"
import { InputController } from "./ui/input-controller.js"
import { createUILayout } from "./ui/layout.js"
import { ModelPicker } from "./ui/model-picker.js"
import { PermissionController } from "./ui/permission-controller.js"
import { SessionPicker } from "./ui/session-picker.js"
import { SessionStatus } from "./ui/session-status.js"
import { TranscriptView } from "./ui/transcript-view.js"
import type { ChatUIOptions, ModelPickerItem, Renderer, SessionPickerItem } from "./ui/types.js"

export type { CommandSuggestion, ModelPickerItem, SessionPickerItem } from "./ui/types.js"

export function createChatUI(renderer: Renderer, options: ChatUIOptions) {
  let showingWelcome = true
  let commandMenuVisible = false
  let modelPickerVisible = false
  let sessionPickerVisible = false
  let busy = false
  let updateHintVisible = false

  const {
    agentBar,
    chatBody,
    commandMenu,
    contextLabel,
    input,
    inputArea,
    inputBox,
    inputHint,
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
    setupForm,
    setupInput,
    setupInputLabel,
    setupMessage,
    setupStatus,
    setupStatusBox,
    statBoxes,
    statsRow,
    topBar,
    updateHint,
    welcome,
    welcomePanel,
    welcomeQuit,
  } = createUILayout(renderer, options)
  const commands = new CommandMenu(renderer, commandMenu, options.commands ?? [])
  const models = new ModelPicker(renderer, modelRowsBox)
  const sessions = new SessionPicker(renderer, sessionRowsBox)
  const sessionStatus = new SessionStatus(renderer, sessionLabel, options.sessionLabel)
  const transcriptView = new TranscriptView(renderer, messages, options.treeSitterClient)
  const permissions = new PermissionController({
    renderer,
    inputArea,
    prompt: permissionPrompt,
    label: permissionLabel,
  })
  const status = new AgentStatus({
    renderer,
    root,
    inputArea,
    agentBar,
    inputHint,
    isWelcomeVisible: () => showingWelcome,
    isCommandMenuVisible: () => commandMenuVisible,
    onInterrupt: options.onInterrupt,
  })
  let selectedModelName = options.modelLabel
  status.setInputHint(homeModelHint(selectedModelName))
  const startThinkingAnimation = () => status.startThinking()
  const stopThinkingAnimation = () => status.stopThinking()
  const inputController = new InputController({
    renderer,
    configured: options.configured !== false,
    input,
    inputArea,
    inputBox,
    setupButtonBox,
    setupForm,
    setupInput,
    setupInputLabel,
    setupMessage,
    setupStatus,
    setupStatusBox,
    welcomeQuit,
    isUpdateHintVisible: () => updateHintVisible,
    onBeforePrimaryInput: hideCommandMenu,
    onSetupSubmit: options.onSetupSubmit,
  })

  input.onSubmit = () => {
    if (inputController.mode !== "chat") return

    const value = input.plainText

    if (commandMenuVisible) {
      const selected = commands.selected()
      hideCommandMenu()
      options.onSubmit(selected?.name ?? value.trim())
      return
    }

    hideCommandMenu()
    options.onSubmit(value.trim())
  }

  input.onContentChange = () => {
    if (inputController.mode !== "chat") return

    const value = input.plainText
    updateCommandMenu(value)
    options.onInputChange?.(value)
  }

  renderer.keyInput.on("keypress", (key) => {
    if (inputController.mode === "setupButton" && (key.name === "return" || key.name === "enter")) {
      stopKey(key)
      options.onSetup?.()
      return
    }

    if (permissions.handleKey(key)) return
    if (commandMenuVisible && handleCommandMenuKey(key)) return
    if (modelPickerVisible && handleModelPickerKey(key)) return
    if (sessionPickerVisible && handleSessionPickerKey(key)) return
    if (inputController.mode !== "chat") return

    if (key.name === "escape") {
      stopKey(key)
      if (busy) status.handleEscape()
      return
    }

    if (key.name !== "tab" && key.sequence !== "\t") return

    stopKey(key)
    options.onToggleMode?.()
    focusInput()
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

  function renderTranscript(entries: TranscriptEntry[], options: { scrollToBottom?: boolean } = {}) {
    transcriptView.render(entries, options)
  }

  function showSessionPicker(items: SessionPickerItem[]) {
    showChatLayout()
    if (modelPickerVisible) {
      chatBody.remove(modelPanel.id)
      modelPickerVisible = false
    }
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
    if (sessionPickerVisible) {
      chatBody.remove(sessionPanel.id)
      sessionPickerVisible = false
    }
    models.setItems(items)
    if (!modelPickerVisible) {
      chatBody.add(modelPanel, 0)
      modelPickerVisible = true
    }
    renderer.requestRender()
  }

  function hideModelPicker() {
    if (!modelPickerVisible) return
    chatBody.remove(modelPanel.id)
    modelPickerVisible = false
    focusInput()
    renderer.requestRender()
  }

  function hideSessionPicker() {
    if (!sessionPickerVisible) return
    chatBody.remove(sessionPanel.id)
    sessionPickerVisible = false
    focusInput()
    renderer.requestRender()
  }

  function showChatLayout() {
    if (!showingWelcome) return
    status.setInputHint(ESC_INTERRUPT_HINT)

    root.live = false
    Object.assign(inputBox, {
      width: "100%",
      maxWidth: undefined,
      minWidth: 1,
    })
    inputArea.backgroundColor = colors.background
    inputArea.marginTop = 1
    welcomePanel.remove(inputArea.id)
    root.remove(welcome.id)
    root.add(topBar)
    chatBody.add(messages)
    root.add(chatBody)
    root.add(inputArea)
    showingWelcome = false
    renderer.requestRender()
  }

  function showHomeLayout() {
    if (showingWelcome) return

    hideCommandMenu()
    if (sessionPickerVisible) {
      chatBody.remove(sessionPanel.id)
      sessionPickerVisible = false
    }
    if (modelPickerVisible) {
      chatBody.remove(modelPanel.id)
      modelPickerVisible = false
    }
    status.hideForHome()
    status.setInputHint(homeModelHint(selectedModelName))

    root.live = true
    Object.assign(inputBox, {
      width: "100%",
      maxWidth: undefined,
      minWidth: 24,
    })
    inputArea.marginTop = 0
    root.remove(topBar.id)
    root.remove(chatBody.id)
    root.remove(inputArea.id)
    chatBody.remove(messages.id)
    welcomePanel.add(inputArea, 0)
    root.add(welcome)
    showingWelcome = true
    renderer.requestRender()
  }

  function clearInput() {
    inputController.clear()
    hideCommandMenu()
  }

  function focusInput() {
    inputController.focus()
  }

  function setConfigured() {
    inputController.setConfigured()
    showStats()
  }

  function showSetupButton() {
    inputController.showSetupButton()
  }

  function showSetupInput(credential: "fireworks" | "parallel", message?: string) {
    inputController.showSetup(credential, message)
  }

  function showSetupError(message: string) {
    inputController.showSetupError(message)
  }

  function showSetupStatus(message?: string) {
    inputController.showSetupStatus(message)
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
  }

  function showPermissionPrompt(detail: string): Promise<boolean> {
    return permissions.show(detail)
  }

  function hidePermissionPrompt() {
    permissions.hide()
  }

  function setSessionLabel(label: string) {
    sessionStatus.setLabel(label)
  }

  function setDiffStats(added: number, removed: number) {
    sessionStatus.setDiff(added, removed)
  }

  function setBusy(value: boolean) {
    busy = value
    if (!value) status.clearInterrupt()
  }

  function showUpdateHint() {
    setText(updateHint, "New update available — run `otis update`")
    if (!updateHintVisible) {
      inputArea.add(updateHint, 0)
      updateHintVisible = true
    }
    renderer.requestRender()
  }

  function hideUpdateHint() {
    if (!updateHintVisible) return
    inputArea.remove(updateHint.id)
    updateHintVisible = false
    renderer.requestRender()
  }

  function updateCommandMenu(value: string) {
    if (!commands.update(value, showingWelcome)) {
      hideCommandMenu()
      return
    }
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

  function hideCommandMenu() {
    if (!commandMenuVisible) return
    inputArea.remove(commandMenu.id)
    commandMenuVisible = false
    commands.clear()
    status.restoreAfterOverlay()
    renderer.requestRender()
  }

  function handleCommandMenuKey(key: { name: string; preventDefault(): void; stopPropagation(): void }) {
    const handled = commands.handleKey(key, {
      close: hideCommandMenu,
      select: (command) => options.onSubmit(command.name),
    })
    if (handled && key.name === "escape") focusInput()
    return handled
  }

  function handleSessionPickerKey(key: {
    name: string
    ctrl?: boolean
    meta?: boolean
    preventDefault(): void
    stopPropagation(): void
  }) {
    return sessions.handleKey(key, {
      close: hideSessionPicker,
      create: () => options.onNewSession?.(),
      delete: (sessionId) => options.onDeleteSession?.(sessionId),
      select: (sessionId) => options.onSelectSession?.(sessionId),
    })
  }

  function handleModelPickerKey(key: { name: string; preventDefault(): void; stopPropagation(): void }) {
    return models.handleKey(key, {
      close: () => {
        hideModelPicker()
        options.onCloseModelPicker?.()
      },
      select: (model) => options.onSelectModel?.(model),
    })
  }

  focusInput()

  function setStats(stats: LocalStats) {
    const items = formatStats(stats)
    for (let i = 0; i < statBoxes.length; i++) {
      const box = statBoxes[i]
      setText(box.value, items[i].value)
      setText(box.label, items[i].label)
    }
    renderer.requestRender()
  }

  function showStats() {
    if (!welcome.getChildren().some((child) => child.id === statsRow.id)) welcome.add(statsRow, 1)
    renderer.requestRender()
  }

  return {
    clearInput,
    focusInput,
    hidePermissionPrompt,
    hideModelPicker,
    hideSessionPicker,
    hideUpdateHint,
    renderTranscript,
    setBusy,
    setContextLabel,
    setDiffStats,
    setModeLabel,
    setModelLabel,
    setConfigured,
    setSessionLabel,
    setStats,
    showStats,
    showModelPicker,
    showSetupError,
    showSetupButton,
    showSetupInput,
    showSetupStatus,
    showPermissionPrompt,
    showSessionPicker,
    showChatLayout,
    showHomeLayout,
    showUpdateHint,
    startThinkingAnimation,
    stopThinkingAnimation,
  }
}

function homeModelHint(modelName: string) {
  return modelName ? ` ${modelName} ` : ""
}

export type ChatUI = ReturnType<typeof createChatUI>

function setText(renderable: TextRenderable, content: string) {
  renderable.content = content
}

function stopKey(key: { preventDefault(): void; stopPropagation(): void }) {
  key.preventDefault()
  key.stopPropagation()
}
