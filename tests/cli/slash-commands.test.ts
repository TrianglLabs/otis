import { describe, expect, it } from "vitest"
import {
  parseSlashCommand,
  slashCommandRunsImmediately,
  slashCommands,
} from "../../src/cli/slash-commands.js"

const SLASH_COMMANDS = slashCommands({ fast: true, effort: true })

describe("slash commands", () => {
  it("parses known commands and leaves unknown input for the agent", () => {
    expect(parseSlashCommand("/exit")).toEqual({ type: "exit" })
    expect(parseSlashCommand("/fast")).toEqual({ type: "fast" })
    expect(parseSlashCommand("/effort")).toEqual({ type: "effort" })
    expect(parseSlashCommand("/effort medium")).toEqual({ type: "effort", level: "medium" })
    expect(parseSlashCommand("/skills")).toEqual({ type: "skills" })
    expect(parseSlashCommand("/skills list")).toEqual({ type: "skills", action: "list" })
    expect(parseSlashCommand("/skills install https://github.com/obra/superpowers")).toEqual({
      type: "skills",
      action: "install",
      target: "https://github.com/obra/superpowers",
    })
    expect(parseSlashCommand("/skills remove pstack")).toEqual({
      type: "skills",
      action: "remove",
      target: "pstack",
    })
    expect(parseSlashCommand("/skills toggle review")).toEqual({
      type: "skills",
      action: "toggle",
      target: "review",
    })
    expect(parseSlashCommand("/skills toggle")).toBeUndefined()
    expect(parseSlashCommand("/skills install")).toBeUndefined()
    expect(parseSlashCommand("/memory")).toEqual({ type: "memory" })
    expect(parseSlashCommand("/memory list")).toEqual({ type: "memory", action: "list" })
    expect(parseSlashCommand("/memory remember Deploys go through CI")).toEqual({
      type: "memory",
      action: "remember",
      target: "Deploys go through CI",
    })
    expect(parseSlashCommand("/memory forget")).toBeUndefined()
    expect(slashCommandRunsImmediately({ type: "memory" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "memory", action: "forget", target: "x" })).toBe(
      false,
    )
    expect(slashCommandRunsImmediately({ type: "skills" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "skills", action: "list" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "skills", action: "install", target: "x" })).toBe(
      false,
    )
    expect(parseSlashCommand("/delete-model")).toEqual({
      type: "settings",
      setting: "delete-model",
    })
    expect(parseSlashCommand("/delete-model openai/gpt-oss-20b")).toEqual({
      type: "settings",
      setting: "delete-model",
      modelId: "openai/gpt-oss-20b",
    })
    expect(parseSlashCommand("/settings")).toEqual({ type: "settings" })
    expect(parseSlashCommand("/settings hosted")).toEqual({ type: "settings", setting: "hosted" })
    expect(parseSlashCommand("/settings pair")).toEqual({ type: "settings", setting: "pair" })
    expect(parseSlashCommand("/settings debug")).toEqual({ type: "settings", setting: "debug" })
    expect(parseSlashCommand("/settings keep-awake")).toEqual({
      type: "settings",
      setting: "keep-awake",
    })
    expect(parseSlashCommand("/settings subagents")).toEqual({
      type: "settings",
      setting: "subagents",
    })
    expect(parseSlashCommand("/settings theme")).toEqual({ type: "settings", setting: "theme" })
    expect(parseSlashCommand("/settings theme nord")).toEqual({ type: "theme", name: "nord" })
    expect(parseSlashCommand("/settings delete-model")).toEqual({
      type: "settings",
      setting: "delete-model",
    })
    expect(parseSlashCommand("/settings delete-model openai/gpt-oss-20b")).toEqual({
      type: "settings",
      setting: "delete-model",
      modelId: "openai/gpt-oss-20b",
    })
    expect(parseSlashCommand("/settings hosted together")).toEqual({
      type: "settings",
      setting: "hosted",
      provider: "together",
    })
    expect(parseSlashCommand("/settings hosted nope")).toBeUndefined()
    expect(parseSlashCommand("/settings models")).toEqual({ type: "settings", setting: "models" })
    expect(parseSlashCommand("/settings models together")).toEqual({
      type: "settings",
      setting: "models",
      provider: "together",
    })
    expect(parseSlashCommand("/settings models nope")).toBeUndefined()
    expect(parseSlashCommand("/settings toggle-model together:Qwen/Qwen3:fast")).toEqual({
      type: "settings",
      setting: "toggle-model",
      provider: "together",
      modelId: "Qwen/Qwen3:fast",
    })
    expect(parseSlashCommand("/settings toggle-model nope")).toBeUndefined()
    expect(parseSlashCommand("/settings toggle-model fireworks:")).toBeUndefined()
    expect(parseSlashCommand("/settings unknown")).toBeUndefined()
    expect(parseSlashCommand("/debug")).toEqual({ type: "settings", setting: "debug" })
    expect(parseSlashCommand("/theme")).toEqual({ type: "settings", setting: "theme" })
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
    expect(slashCommandRunsImmediately({ type: "theme", name: "nord" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "settings" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "settings", setting: "debug" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "settings", setting: "keep-awake" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "settings", setting: "subagents" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "settings", setting: "theme" })).toBe(true)
    expect(slashCommandRunsImmediately({ type: "settings", setting: "hosted" })).toBe(false)
    expect(slashCommandRunsImmediately({ type: "settings", setting: "pair" })).toBe(false)
    expect(slashCommandRunsImmediately({ type: "compact" })).toBe(false)
  })

  it("advertises queue as an editable command", () => {
    const commands = slashCommands({ fast: true })
    expect(commands.find((command) => command.name === "/queue")).toMatchObject({
      draft: "/queue ",
    })
  })

  it("advertises the top-level commands without the settings-only theme picker", () => {
    const names = SLASH_COMMANDS.map((command) => command.name)
    expect(names).toEqual([
      "/home",
      "/new",
      "/fork",
      "/history",
      "/model",
      "/settings",
      "/skills",
      "/memory",
      "/fast",
      "/queue",
      "/compact",
      "/thinking",
      "/effort",
      "/exit",
    ])
  })

  it("omits /fast and /effort unless the current model has them", () => {
    const names = (options: Parameters<typeof slashCommands>[0]) =>
      slashCommands(options).map((command) => command.name)
    expect(names({ fast: true, effort: true })).toEqual(
      expect.arrayContaining(["/fast", "/effort"]),
    )
    expect(names({ fast: false, effort: false })).not.toEqual(expect.arrayContaining(["/fast"]))
    expect(names({ fast: false, effort: false })).not.toContain("/effort")
    expect(names({})).not.toContain("/effort")
    expect(parseSlashCommand("/fast")).toEqual({ type: "fast" })
    expect(parseSlashCommand("/effort high")).toEqual({ type: "effort", level: "high" })
  })

  it("parses every advertised command", () => {
    for (const command of SLASH_COMMANDS) {
      expect(parseSlashCommand(command.name), command.name).toBeDefined()
    }
  })
})

describe("skill commands", () => {
  it("lists the skills the user may run after the built-ins, which keep their names", () => {
    const commands = slashCommands({
      skills: [
        { name: "tdd", description: "Test first." },
        { name: "skills", description: "Shadowed by the built-in." },
      ],
    })
    expect(commands.at(-1)).toEqual({ name: "/tdd", description: "Test first.", draft: "/tdd " })
    // A long description reads as its first short sentence, or a cut that fits a menu line.
    const [first, second] = slashCommands({
      skills: [
        {
          name: "architect",
          description:
            "Sketch types, signatures, and module structure before code, then stay in the loop " +
            "while implementation fills in. Use for /architect or non-trivial work.",
        },
        {
          name: "why",
          description: "Ask why.\n\nUse when a decision needs its reasons spelled out at length.",
        },
      ],
    }).slice(-2)
    // A long first sentence is cut at a word boundary, near the built-in commands' length.
    expect(first?.description).toBe("Sketch types, signatures, and module structure before code,…")
    expect(first?.description.length).toBeLessThanOrEqual(61)
    expect(second?.description).toBe("Ask why.")
    expect(commands.filter((command) => command.name === "/skills")).toEqual([
      { name: "/skills", description: "List and install Agent Skills" },
    ])
    // The parser leaves a skill's command to the prompt path, which runs the skill.
    expect(parseSlashCommand("/tdd fix the lock")).toBeUndefined()
  })
})
