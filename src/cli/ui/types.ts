import type { TreeSitterClient } from "@opentui/core"
import type { FireworksModel } from "../../inference/types.js"
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
  treeSitterClient?: TreeSitterClient
  onInputChange?: (value: string) => void
  onInterrupt?: () => void
  onSetup?: () => void
  onSetupSubmit?: (credential: SetupCredential, apiKey: string) => void
  onCloseModelPicker?: () => void
  onSelectModel?: (model: FireworksModel) => void
  onNewSession?: () => void
  onDeleteSession?: (sessionId: string) => void
  onSelectSession?: (sessionId: string) => void
  onSubmit: (value: string) => void
  onToggleMode?: () => void
}

export type { FireworksModel, SessionPickerItem }
