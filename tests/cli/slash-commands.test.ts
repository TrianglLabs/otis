import { describe, expect, it } from "vitest"
import {
  parseSlashCommand,
  SLASH_COMMANDS,
  slashCommandRunsImmediately,
  slashCommands,
} from "../../src/cli/slash-commands.js"
import { THEME_NAMES } from "../../src/local/settings.js"

describe("slash commands", () => {
  it("parses known commands and leaves unknown input for the agent", () => {
    expect(parseSlashCommand("/exit")).toEqual({ type: "exit" })
    expect(parseSlashCommand("/fast")).toEqual({ type: "fast" })
    expect(parseSlashCommand("/delete-model")).toEqual({ type: "settings", setting: "delete-model" })
    expect(parseSlashCommand("/delete-model openai/gpt-oss-20b")).toEqual({
      type: "settings",
      setting: "delete-model",
      modelId: "openai/gpt-oss-20b",
    })
    expect(parseSlashCommand("/settings")).toEqual({ type: "settings" })
    expect(parseSlashCommand("/settings hosted")).toEqual({ type: "settings", setting: "hosted" })
    expect(parseSlashCommand("/settings pair")).toEqual({ type: "settings", setting: "pair" })
    expect(parseSlashCommand("/settings debug")).toEqual({ type: "settings", setting: "debug" })
    expect(parseSlashCommand("/settings subagents")).toEqual({ type: "settings", setting: "subagents" })
    expect(parseSlashCommand("/settings delete-model")).toEqual({ type: "settings", setting: "delete-model" })
    expect(parseSlashCommand("/settings delete-model openai/gpt-oss-20b")).toEqual({
      type: "settings",
      setting: "delete-model",
      modelId: "openai/gpt-oss-20b",
    })
    expect(parseSlashCommand("/settings unknown")).toBeUndefined()
    expect(parseSlashCommand("/debug")).toEqual({ type: "settings", setting: "debug" })
    expect(parseSlashCommand("/theme")).toEqual({ type: "theme-menu" })
    expect(parseSlashCommand("/theme nord")).toEqual({ type: "theme", name: "nord" })
    expect(parseSlashCommand("/compact")).toEqual({ type: "compact" })
    expect(parseSlashCommand("/compact keep the latest error")).toEqual({
      type: "compact",
      instructions: "keep the latest error",
    })
    expect(parseSlashCommand("/queue check the tests too")).toEqual({
      type: "queue",
      prompt: "check the tests too",
    })
    expect(parseSlashCommand("/compacted")).toBeUndefined()
    expect(parseSlashCommand("/themes")).toBeUndefined()
    expect(parseSlashCommand("hello")).toBeUndefined()
  })

  it("identifies commands that can mutate UI state immediately", () => {
    expect(slashCommandRunsImmediately({ type: "exit" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "history" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "home" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "model" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "thinking" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "theme-menu" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "theme", name: "nord" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "settings" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "settings", setting: "debug" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "settings", setting: "subagents" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "settings", setting: "hosted" })).toBe(false)
    expect(slashCommandRunsImmediately({ type: "settings", setting: "pair" })).toBe(false)
    expect(slashCommandRunsImmediately({ type: "compact" })).toBe(false)
  })

  it("advertises queue as an editable command", () => {
    const commands = slashCommands({ fast: true })
    expect(commands.find((command) => command.name === "/queue")).toMatchObject({ draft: "/queue " })
  })

  it("advertises every built-in command including theme names", () => {
    const names = SLASH_COMMANDS.map((command) => command.name)
    expect(names.slice(0, 10)).toEqual([
      "/home",
      "/new",
      "/history",
      "/model",
      "/settings",
      "/fast",
      "/queue",
      "/compact",
      "/thinking",
      "/theme",
    ])
    expect(names.at(-1)).toBe("/exit")
    expect(names.slice(10, -1)).toEqual(THEME_NAMES.map((theme) => `/theme ${theme}`))
  })

  it("omits /fast unless the current model has a Fast serving path", () => {
    expect(slashCommands({ fast: true }).some((command) => command.name === "/fast")).toBe(true)
    expect(slashCommands({ fast: false }).some((command) => command.name === "/fast")).toBe(false)
    expect(parseSlashCommand("/fast")).toEqual({ type: "fast" })
  })

  it("keeps the former model deletion command as an unadvertised alias", () => {
    expect(SLASH_COMMANDS.some((command) => command.name === "/delete-model")).toBe(false)
    expect(parseSlashCommand("/delete-model")).toEqual({ type: "settings", setting: "delete-model" })
  })

  it("parses every advertised command", () => {
    for (const command of SLASH_COMMANDS) {
      expect(parseSlashCommand(command.name), command.name).toBeDefined()
    }
  })
})
