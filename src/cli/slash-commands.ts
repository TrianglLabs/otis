import { type HostedProvider, isHostedProvider } from "../inference/types.js"
import type { CommandSuggestion } from "./ui/types.js"

export type SlashCommand =
  | { type: "exit" }
  | { type: "theme"; name: string }
  | { type: "model" }
  | {
      type: "settings"
      setting?:
        | "hosted"
        | "servers"
        | "pair"
        | "debug"
        | "subagents"
        | "delete-model"
        | "models"
        | "toggle-model"
        | "theme"
      modelId?: string
      /**
       * `/settings hosted <provider>` opens that provider's key form, `/settings models <provider>`
       * its model list, and `/settings toggle-model <provider>:<id>` flips a model's visibility.
       */
      provider?: HostedProvider
    }
  | { type: "fast" }
  | { type: "history" }
  | { type: "new" }
  | { type: "home" }
  | { type: "thinking" }
  | { type: "effort"; level?: string }
  | { type: "queue"; prompt?: string }
  | { type: "compact"; instructions?: string }
  | { type: "skills"; action?: "list" }
  | { type: "skills"; action: "source" | "install" | "update" | "remove"; target: string }
  | { type: "memory"; action?: "list" }
  | { type: "memory"; action: "remember" | "forget"; target: string }

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
const SETTINGS = ["hosted", "pair", "servers", "debug", "subagents", "models", "theme"] as const

const CATALOG: readonly CatalogCommand[] = [
  { type: "home", name: "/home", description: "Return to home screen" },
  { type: "new", name: "/new", description: "Start a new session" },
  { type: "history", name: "/history", description: "Open session history" },
  { type: "model", name: "/model", description: "Choose a model" },
  { type: "settings", name: "/settings", description: "Configure Otis" },
  { type: "skills", name: "/skills", description: "List and install Agent Skills" },
  { type: "memory", name: "/memory", description: "See, add, or forget remembered facts" },
  { type: "fast", name: "/fast", description: "Toggle Fast serving" },
  { type: "queue", name: "/queue", description: "Queue a separate follow-up" },
  { type: "compact", name: "/compact", description: "Summarize old conversation to free context" },
  { type: "thinking", name: "/thinking", description: "Show or hide model thinking traces" },
  { type: "effort", name: "/effort", description: "Set local thinking effort" },
  { type: "exit", name: "/exit", description: "Exit Otis" },
]

/** The catalog as the menu lists it; `/fast` and `/effort` only when the selected model has them. */
export function slashCommands(
  options: { fast?: boolean; effort?: boolean } = {},
): CommandSuggestion[] {
  return CATALOG.filter(
    (command) => (command.type !== "fast" && command.type !== "effort") || options[command.type],
  ).map((command) => ({
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
  if (name === "/skills") {
    const [action, ...rest] = argument.split(/\s+/u)
    const target = rest.join(" ")
    if (action === "list" && !target) return { type: "skills", action }
    if (
      target &&
      (action === "source" || action === "install" || action === "update" || action === "remove")
    )
      return { type: "skills", action, target }
    return undefined
  }
  if (name === "/memory") {
    const [action, ...rest] = argument.split(/\s+/u)
    const target = rest.join(" ")
    if (action === "list" && !target) return { type: "memory", action }
    if (target && (action === "remember" || action === "forget"))
      return { type: "memory", action, target }
    return undefined
  }
  if (name !== "/settings") return undefined
  const setting = SETTINGS.find((candidate) => candidate === argument)
  if (setting) return { type: "settings", setting }
  for (const setting of ["hosted", "models"] as const) {
    if (!argument.startsWith(`${setting} `)) continue
    const provider = argument.slice(setting.length).trim()
    return isHostedProvider(provider) ? { type: "settings", setting, provider } : undefined
  }
  if (argument.startsWith("toggle-model ")) {
    const key = argument.slice("toggle-model".length).trim()
    const provider = key.slice(0, key.indexOf(":"))
    const modelId = key.slice(provider.length + 1)
    return isHostedProvider(provider) && modelId
      ? { type: "settings", setting: "toggle-model", provider, modelId }
      : undefined
  }
  if (argument === "delete-model" || argument.startsWith("delete-model ")) {
    const modelId = argument.slice("delete-model".length).trim()
    return { type: "settings", setting: "delete-model", ...(modelId ? { modelId } : {}) }
  }
  if (argument.startsWith("theme "))
    return { type: "theme", name: argument.slice("theme".length).trim() }
  return undefined
}

export function slashCommandRunsImmediately(command: SlashCommand) {
  // Skills and memory actions that change files wait for the turn; the rest only show something.
  if (command.type === "skills")
    return (
      command.action !== "install" && command.action !== "update" && command.action !== "remove"
    )
  if (command.type === "memory") return command.action !== "remember" && command.action !== "forget"
  if (command.type !== "settings") return IMMEDIATE_TYPES.has(command.type)
  return (
    command.setting === undefined ||
    command.setting === "debug" ||
    command.setting === "subagents" ||
    command.setting === "theme"
  )
}
