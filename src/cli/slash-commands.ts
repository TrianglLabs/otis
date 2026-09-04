import { THEME_NAMES } from "../local/settings.js"
import type { CommandSuggestion } from "./ui/types.js"

export type SlashCommand =
  | { type: "exit" }
  | { type: "theme-menu" }
  | { type: "theme"; name: string }
  | { type: "model" }
  | { type: "settings"; setting?: "hosted" | "pair" | "debug" | "delete-model"; modelId?: string }
  | { type: "fast" }
  | { type: "history" }
  | { type: "new" }
  | { type: "home" }
  | { type: "thinking" }
  | { type: "queue"; prompt?: string }
  | { type: "compact"; instructions?: string }

type CatalogCommand = {
  type: SlashCommand["type"]
  name: string
  description: string
}

const IMMEDIATE_TYPES = new Set<SlashCommand["type"]>([
  "exit",
  "history",
  "home",
  "model",
  "thinking",
  "theme-menu",
  "theme",
])

const CATALOG: readonly CatalogCommand[] = [
  { type: "home", name: "/home", description: "Return to home screen" },
  { type: "new", name: "/new", description: "Start a new session" },
  { type: "history", name: "/history", description: "Open session history" },
  { type: "model", name: "/model", description: "Choose a model" },
  { type: "settings", name: "/settings", description: "Configure Otis" },
  { type: "fast", name: "/fast", description: "Toggle Fast serving" },
  { type: "queue", name: "/queue", description: "Queue a separate follow-up" },
  { type: "compact", name: "/compact", description: "Summarize old conversation to free context" },
  { type: "thinking", name: "/thinking", description: "Show or hide model thinking traces" },
  { type: "theme-menu", name: "/theme", description: "Choose a color theme" },
  ...THEME_NAMES.map((theme) => ({ type: "theme" as const, name: `/theme ${theme}`, description: "" })),
  { type: "exit", name: "/exit", description: "Exit Otis" },
]

export function slashCommands(options: { fast?: boolean } = {}): CommandSuggestion[] {
  return CATALOG.filter((command) => command.type !== "fast" || options.fast).map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.type === "queue" ? { draft: "/queue " } : {}),
  }))
}

export const SLASH_COMMANDS: CommandSuggestion[] = slashCommands({ fast: true })

export function parseSlashCommand(value: string): SlashCommand | undefined {
  // `/debug` shipped before Debug mode moved into Settings. Keep the command
  // working without advertising it in the top-level command catalog.
  if (value === "/debug") return { type: "settings", setting: "debug" }
  // Keep the former top-level model cleanup command working as a hidden alias.
  if (value === "/delete-model") return { type: "settings", setting: "delete-model" }
  const exact = CATALOG.find((command) => command.name === value)
  if (exact) return toSlashCommand(exact)
  if (value.startsWith("/compact ")) {
    return { type: "compact", instructions: value.slice("/compact".length).trim() }
  }
  if (value.startsWith("/queue ")) {
    const prompt = value.slice("/queue".length).trim()
    return { type: "queue", ...(prompt ? { prompt } : {}) }
  }
  if (value.startsWith("/delete-model ")) {
    const modelId = value.slice("/delete-model".length).trim()
    return { type: "settings", setting: "delete-model", ...(modelId ? { modelId } : {}) }
  }
  if (value.startsWith("/settings ")) {
    const setting = value.slice("/settings".length).trim()
    if (setting === "hosted" || setting === "pair" || setting === "debug") return { type: "settings", setting }
    if (setting === "delete-model") return { type: "settings", setting: "delete-model" }
    if (setting.startsWith("delete-model ")) {
      const modelId = setting.slice("delete-model".length).trim()
      return { type: "settings", setting: "delete-model", ...(modelId ? { modelId } : {}) }
    }
    return undefined
  }
  if (value.startsWith("/theme ")) {
    return { type: "theme", name: value.slice("/theme".length).trim() }
  }
  return undefined
}

export function slashCommandRunsImmediately(command: SlashCommand) {
  if (command.type === "settings") return command.setting === undefined || command.setting === "debug"
  return IMMEDIATE_TYPES.has(command.type)
}

function toSlashCommand(command: CatalogCommand): SlashCommand {
  if (command.type === "theme") return { type: "theme", name: command.name.slice("/theme ".length) }
  if (command.type === "compact") return { type: "compact" }
  if (command.type === "queue") return { type: "queue" }
  return { type: command.type }
}
