import type { CommandSuggestion } from "./ui/types.js"

export type SlashCommand =
  | { type: "exit" }
  | { type: "theme"; name: string }
  | { type: "model" }
  | {
      type: "settings"
      setting?: "hosted" | "servers" | "pair" | "debug" | "subagents" | "delete-model" | "theme"
      modelId?: string
    }
  | { type: "fast" }
  | { type: "history" }
  | { type: "new" }
  | { type: "home" }
  | { type: "thinking" }
  | { type: "effort"; level?: string }
  | { type: "queue"; prompt?: string }
  | { type: "compact"; instructions?: string }

type CatalogCommand = {
  type: Exclude<SlashCommand["type"], "theme">
  name: string
  description: string
}

const IMMEDIATE_TYPES = new Set<SlashCommand["type"]>([
  "exit",
  "history",
  "home",
  "model",
  "new",
  "thinking",
  "theme",
])
const SETTINGS = ["hosted", "pair", "servers", "debug", "subagents", "theme"] as const

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
  { type: "effort", name: "/effort", description: "Set local thinking effort" },
  { type: "exit", name: "/exit", description: "Exit Otis" },
]

export function slashCommands(options: { fast?: boolean } = {}): CommandSuggestion[] {
  return CATALOG.filter((command) => command.type !== "fast" || options.fast).map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.type === "queue" ? { draft: "/queue " } : {}),
  }))
}

export function parseSlashCommand(value: string): SlashCommand | undefined {
  // `/debug`, `/delete-model`, and `/theme` shipped before those settings moved under
  // `/settings`; keep them working without advertising them in the command catalog.
  const input = /^\/(debug|delete-model|theme)(?: |$)/.test(value)
    ? `/settings ${value.slice(1)}`
    : value
  const exact = CATALOG.find((command) => command.name === input)
  if (exact) return { type: exact.type } as SlashCommand
  const split = /^(\/[a-z-]+) (.*)$/s.exec(input)
  if (!split) return undefined
  const name = split[1]
  const argument = split[2].trim()
  if (name === "/compact") return { type: "compact", instructions: argument }
  if (name === "/effort") return { type: "effort", level: argument }
  if (name === "/queue") return { type: "queue", ...(argument ? { prompt: argument } : {}) }
  if (name !== "/settings") return undefined
  const setting = SETTINGS.find((candidate) => candidate === argument)
  if (setting) return { type: "settings", setting }
  if (argument === "delete-model" || argument.startsWith("delete-model ")) {
    const modelId = argument.slice("delete-model".length).trim()
    return { type: "settings", setting: "delete-model", ...(modelId ? { modelId } : {}) }
  }
  if (argument.startsWith("theme "))
    return { type: "theme", name: argument.slice("theme".length).trim() }
  return undefined
}

export function slashCommandRunsImmediately(command: SlashCommand) {
  if (command.type !== "settings") return IMMEDIATE_TYPES.has(command.type)
  return (
    command.setting === undefined ||
    command.setting === "debug" ||
    command.setting === "subagents" ||
    command.setting === "theme"
  )
}
