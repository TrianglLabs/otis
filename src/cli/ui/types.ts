import type { TreeSitterClient } from "@opentui/core"
import type { ModelPickerItem, ModelPickerStatus } from "../../inference/picker-catalog.js"
import type { ThemeName } from "../../local/settings.js"
import type { LocalStats } from "../../local/stats.js"
import type { SessionPickerItem } from "../session-metadata.js"
import type { ThemeColors } from "../theme.js"
import type { TranscriptEntry } from "../transcript.js"
import type { AgentPhase } from "./format.js"

export type Renderer = Awaited<ReturnType<typeof import("@opentui/core").createCliRenderer>>

export type SetupInferenceChoice = "local" | "hosted"
export type SetupLocalInferenceChoice = "managed" | "pair"
export type SetupInputCancelTarget = "choice" | "local" | "configured"
export type PairEndpointInputs = { ollama: string; lmStudio: string }

export type InputMode =
  | "chat"
  | "inactive"
  | "setupButton"
  | "setupChoice"
  | "setupLocalChoice"
  | "setupInput"
  | "setupPairInput"
  | "setupStatus"

export type CommandSuggestion = {
  name: string
  description: string
  submission?: string
  draft?: string
}

export type { ModelPickerItem }

export type ChatUIOptions = {
  configured?: boolean
  localInferenceUnavailableReason?: string
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
  onSetupInferenceChoice?: (choice: SetupInferenceChoice) => void
  onSetupLocalInferenceChoice?: (choice: SetupLocalInferenceChoice) => void
  onSetupSubmit?: (value: string) => void
  onPairSetupSubmit?: (endpoints: PairEndpointInputs) => void
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
  setModelPickerStatus(modelId: string, status: ModelPickerStatus | undefined): void
  setCommands(commands: CommandSuggestion[]): void
  setConfigured(): void
  setSessionLabel(label: string): void
  setStats(stats: LocalStats): void
  setTheme(theme: ThemeName, previous: ThemeColors): void
  setThinkingVisible(visible: boolean): void
  showStats(): void
  showTransientHint(content: string): void
  showCommandSubmenu(items: CommandSuggestion[], options?: { onBack?: () => void }): void
  showSlashCommandMenu(): void
  showModelPicker(items: ModelPickerItem[]): void
  showSetupError(message: string, cancelTarget: SetupInputCancelTarget): void
  showSetupInferenceChoice(message?: string): void
  showSetupLocalInferenceChoice(message?: string): void
  showSetupInput(message?: string, cancelTarget?: SetupInputCancelTarget): void
  showPairSetup(message: string, cancelTarget: SetupInputCancelTarget, endpoints: PairEndpointInputs): void
  showPairSetupError(message: string, cancelTarget: SetupInputCancelTarget, endpoints: PairEndpointInputs): void
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
