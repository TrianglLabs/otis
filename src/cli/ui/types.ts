import type { TreeSitterClient } from "@opentui/core"
import type { FireworksModel } from "../../inference/types.js"
import type { ThemeName } from "../../local/settings.js"
import type { SessionPickerItem } from "../session-metadata.js"

export type Renderer = Awaited<ReturnType<typeof import("@opentui/core").createCliRenderer>>

export type InputMode = "chat" | "inactive" | "setupButton" | "setupInput" | "setupStatus"
export type SetupCredential = "fireworks" | "parallel"

export type CommandSuggestion = {
  name: string
  description: string
}

export type ModelPickerItem = FireworksModel & { active?: boolean }

export type ChatUIOptions = {
  configured?: boolean
  statsVisible?: boolean
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
  onSetup?: () => void
  onSetupSubmit?: (credential: SetupCredential, apiKey: string) => void
  onCloseModelPicker?: () => void
  onSelectModel?: (model: FireworksModel) => void
  onNewSession?: () => void
  onDeleteSession?: (sessionId: string) => void
  onSelectSession?: (sessionId: string) => void
  onSubmit: (value: string) => void | Promise<void>
  onToggleMode?: () => void
  onPreviewTheme?: (theme: ThemeName) => void
  onCancelThemePreview?: () => void
}

export type { FireworksModel, SessionPickerItem }
