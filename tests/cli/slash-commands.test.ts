import { describe, expect, it } from "vitest"
import {
  parseSlashCommand,
  SLASH_COMMANDS,
  slashCommandIgnoresBusy,
  slashCommands,
} from "../../src/cli/slash-commands.js"
import { THEME_NAMES } from "../../src/local/settings.js"

describe("slash commands", () => {
  it("parses known commands and leaves unknown input for the agent", () => {
    expect(parseSlashCommand("/exit")).toEqual({ type: "exit" })
    expect(parseSlashCommand("/fast")).toEqual({ type: "fast" })
    expect(parseSlashCommand("/theme")).toEqual({ type: "theme-menu" })
    expect(parseSlashCommand("/theme nord")).toEqual({ type: "theme", name: "nord" })
    expect(parseSlashCommand("/compact")).toEqual({ type: "compact" })
    expect(parseSlashCommand("/compact keep the latest error")).toEqual({
      type: "compact",
      instructions: "keep the latest error",
    })
    expect(parseSlashCommand("/compacted")).toBeUndefined()
    expect(parseSlashCommand("/themes")).toBeUndefined()
    expect(parseSlashCommand("hello")).toBeUndefined()
  })

  it("lets exit and theme commands run while a turn is busy", () => {
    expect(slashCommandIgnoresBusy({ type: "exit" })).toBe(true)
    expect(slashCommandIgnoresBusy({ type: "theme-menu" })).toBe(true)
    expect(slashCommandIgnoresBusy({ type: "theme", name: "nord" })).toBe(true)
    expect(slashCommandIgnoresBusy({ type: "home" })).toBe(false)
    expect(slashCommandIgnoresBusy({ type: "compact" })).toBe(false)
  })

  it("advertises every built-in command including theme names", () => {
    const names = SLASH_COMMANDS.map((command) => command.name)
    expect(names.slice(0, 9)).toEqual([
      "/home",
      "/new",
      "/history",
      "/model",
      "/fast",
      "/compact",
      "/debug",
      "/thinking",
      "/theme",
    ])
    expect(names.at(-1)).toBe("/exit")
    expect(names.slice(9, -1)).toEqual(THEME_NAMES.map((theme) => `/theme ${theme}`))
  })

  it("omits /fast unless the current model has a Fast serving path", () => {
    expect(slashCommands({ fast: true }).some((command) => command.name === "/fast")).toBe(true)
    expect(slashCommands({ fast: false }).some((command) => command.name === "/fast")).toBe(false)
    expect(parseSlashCommand("/fast")).toEqual({ type: "fast" })
  })

  it("parses every advertised command", () => {
    for (const command of SLASH_COMMANDS) {
      expect(parseSlashCommand(command.name), command.name).toBeDefined()
    }
  })
})
