import type { TreeSitterClient } from "@opentui/core"
import type { ModelPickerItem } from "../../inference/picker-catalog.js"
import type { ThemeName } from "../../local/settings.js"
import type { LocalStats } from "../../local/stats.js"
import type { SessionPickerItem } from "../session-metadata.js"
import type { ThemeColors } from "../theme.js"
import type { TranscriptEntry } from "../transcript.js"
import type { AgentPhase } from "./format.js"

export type Renderer = Awaited<ReturnType<typeof import("@opentui/core").createCliRenderer>>

export type InputMode = "chat" | "inactive" | "setupButton" | "setupInput" | "setupStatus"

export type CommandSuggestion = {
  name: string
  description: string
  submission?: string
}

export type { ModelPickerItem }

export type ChatUIOptions = {
  configured?: boolean
  commands?: CommandSuggestion[]
  contextLabel: string
  modelLabel: string
  modeLabel: string
  sessionLabel: string
  workspaceLabel: string
  theme?: ThemeName
  thinkingVisible?: boolean
  treeSitterClient?: TreeSitterClient
  onInputChange?: (value: string) => void
  onImagePaste?: (bytes: Uint8Array, mimeType?: string) => void | Promise<void>
  onImagePathPaste?: (value: string) => boolean
  onRemoveLastImage?: () => boolean
  onInterrupt?: () => void
  onQuit?: () => void | Promise<void>
  onSetup?: () => void
  onSetupSubmit?: (apiKey: string) => void
  onCloseModelPicker?: () => void
  onSelectModel?: (model: ModelPickerItem) => void
  onNewSession?: () => void
  onDeleteSession?: (sessionId: string) => void
  onSelectSession?: (sessionId: string) => void
  onSubmit: (value: string) => void | Promise<void>
  onToggleMode?: () => void
  onPreviewTheme?: (theme: ThemeName) => void
  onCancelThemePreview?: () => void
}

export type ChatUI = {
  clearInput(): void
  focusInput(): void
  hidePermissionPrompt(): void
  hideModelPicker(): void
  hideSessionPicker(): void
  hideUpdateHint(): void
  renderTranscript(entries: TranscriptEntry[], options?: { scrollToBottom?: boolean }): void
  setBusy(value: boolean): void
  setContextLabel(label: string, color?: string): void
  setDiffStats(added: number, removed: number): void
  setModeLabel(label: string): void
  setImageAttachmentCount(count: number): void
  setModelLabel(label: string): void
  setModelPickerStatus(modelId: string, status: string | undefined): void
  setCommands(commands: CommandSuggestion[]): void
  setConfigured(): void
  setSessionLabel(label: string): void
  setStats(stats: LocalStats): void
  setTheme(theme: ThemeName, previous: ThemeColors): void
  setThinkingVisible(visible: boolean): void
  showStats(): void
  showTransientHint(content: string): void
  showCommandSubmenu(items: CommandSuggestion[]): void
  showModelPicker(items: ModelPickerItem[]): void
  showSetupError(message: string): void
  showSetupButton(): void
  showSetupInput(message?: string): void
  showSetupStatus(message?: string): void
  showPermissionPrompt(detail: string): Promise<boolean>
  showSessionPicker(items: SessionPickerItem[]): void
  showThemeMenu(): void
  showChatLayout(): void
  showHomeLayout(): void
  showUpdateHint(): void
  setAgentPhase(phase: AgentPhase): void
  startBusyIndicator(): void
  stopBusyIndicator(): void
}

export type { SessionPickerItem }
