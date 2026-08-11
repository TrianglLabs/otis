import { describe, expect, it, vi } from "vitest"
import { runSkillsCommand } from "../../src/cli/skills-cli.js"
import type { SkillManager } from "../../src/skills/index.js"

describe("skills CLI", () => {
  it("prints help without initializing a manager operation", async () => {
    const manager = managerMock()
    const output = writable()

    await runSkillsCommand([], { manager, stdout: output.stream })

    expect(output.text()).toContain("install <git-url>")
    expect(manager.list).not.toHaveBeenCalled()
  })

  it("routes install, list, update, and removal with useful output", async () => {
    const source = {
      id: "superpowers",
      url: "https://github.com/obra/superpowers",
      skills: [{ name: "brainstorming", relativePath: "skills/brainstorming" }],
    }
    const manager = managerMock()
    manager.install.mockResolvedValue(source)
    manager.list.mockResolvedValue([source])
    manager.update.mockResolvedValue([source])
    manager.remove.mockResolvedValue(source)

    const installOutput = writable()
    await runSkillsCommand(["install", source.url, "--name", "superpowers"], {
      manager,
      stdout: installOutput.stream,
    })
    expect(manager.install).toHaveBeenCalledWith(source.url, "superpowers")
    expect(installOutput.text()).toContain("Restart Otis")

    const listOutput = writable()
    await runSkillsCommand(["list"], { manager, stdout: listOutput.stream })
    expect(listOutput.text()).toContain("superpowers (1 skill: brainstorming)")
    expect(listOutput.text()).toContain(source.url)

    await runSkillsCommand(["update", "superpowers"], { manager, stdout: writable().stream })
    expect(manager.update).toHaveBeenCalledWith("superpowers")

    await runSkillsCommand(["remove", "superpowers"], { manager, stdout: writable().stream })
    expect(manager.remove).toHaveBeenCalledWith("superpowers")
  })

  it("rejects ambiguous or unknown command arguments", async () => {
    const manager = managerMock()

    await expect(runSkillsCommand(["install"], { manager })).rejects.toThrow("skills install")
    await expect(runSkillsCommand(["list", "extra"], { manager })).rejects.toThrow("does not accept")
    await expect(runSkillsCommand(["update", "one", "two"], { manager })).rejects.toThrow("at most one")
    await expect(runSkillsCommand(["remove"], { manager })).rejects.toThrow("skills remove")
    await expect(runSkillsCommand(["unknown"], { manager })).rejects.toThrow("Unknown skills command")
  })
})

function managerMock() {
  return {
    install: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  } as unknown as SkillManager & {
    install: ReturnType<typeof vi.fn>
    list: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
  }
}

function writable() {
  let value = ""
  return {
    stream: { write: (chunk: string) => (value += chunk) },
    text: () => value,
  }
}
