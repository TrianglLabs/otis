import { THEME_NAMES } from "../local/settings.js"
import type { CommandSuggestion } from "./ui/types.js"

export type SlashCommand =
  | { type: "exit" }
  | { type: "theme-menu" }
  | { type: "theme"; name: string }
  | { type: "model" }
  | { type: "history" }
  | { type: "new" }
  | { type: "home" }
  | { type: "debug" }
  | { type: "thinking" }
  | { type: "compact"; instructions?: string }

type CatalogCommand = {
  type: SlashCommand["type"]
  name: string
  description: string
}

const BUSY_SAFE_TYPES = new Set<SlashCommand["type"]>(["exit", "theme-menu", "theme"])

const CATALOG: readonly CatalogCommand[] = [
  { type: "home", name: "/home", description: "Return to home screen" },
  { type: "new", name: "/new", description: "Start a new session" },
  { type: "history", name: "/history", description: "Open session history" },
  { type: "model", name: "/model", description: "Choose a Fireworks model" },
  { type: "compact", name: "/compact", description: "Summarize old conversation to free context" },
  { type: "debug", name: "/debug", description: "Toggle debug messages" },
  { type: "thinking", name: "/thinking", description: "Show or hide model thinking traces" },
  { type: "theme-menu", name: "/theme", description: "Choose a color theme" },
  ...THEME_NAMES.map((theme) => ({ type: "theme" as const, name: `/theme ${theme}`, description: "" })),
  { type: "exit", name: "/exit", description: "Exit Otis" },
]

export const SLASH_COMMANDS: CommandSuggestion[] = CATALOG.map(({ name, description }) => ({ name, description }))

export function parseSlashCommand(value: string): SlashCommand | undefined {
  const exact = CATALOG.find((command) => command.name === value)
  if (exact) return toSlashCommand(exact)
  if (value.startsWith("/compact ")) {
    return { type: "compact", instructions: value.slice("/compact".length).trim() }
  }
  if (value.startsWith("/theme ")) {
    return { type: "theme", name: value.slice("/theme".length).trim() }
  }
  return undefined
}

export function slashCommandIgnoresBusy(command: SlashCommand) {
  return BUSY_SAFE_TYPES.has(command.type)
}

function toSlashCommand(command: CatalogCommand): SlashCommand {
  if (command.type === "theme") return { type: "theme", name: command.name.slice("/theme ".length) }
  if (command.type === "compact") return { type: "compact" }
  return { type: command.type }
}
