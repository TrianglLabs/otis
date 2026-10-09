import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadProjectContext } from "../../src/core/context.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("loadProjectContext", () => {
  it("returns empty array when no AGENTS.md exists", async () => {
    const cwd = await trackedTempDir()
    expect(loadProjectContext(cwd)).toEqual([])
  })

  it("reads AGENTS.md from the current directory", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "AGENTS.md"), "# Project Rules\nUse TypeScript.", "utf8")

    const files = loadProjectContext(cwd)

    expect(files).toHaveLength(1)
    expect(files[0].path).toBe(join(cwd, "AGENTS.md"))
    expect(files[0].content).toContain("Use TypeScript.")
  })

  it("orders files root-first so the nearest file is last", async () => {
    const root = await trackedTempDir()
    await writeFile(join(root, "AGENTS.md"), "ROOT", "utf8")
    const mid = join(root, "packages")
    await mkdir(mid, { recursive: true })
    await writeFile(join(mid, "AGENTS.md"), "MID", "utf8")
    const leaf = join(mid, "cli")
    await mkdir(leaf, { recursive: true })
    await writeFile(join(leaf, "AGENTS.md"), "LEAF", "utf8")

    const files = loadProjectContext(leaf)

    expect(files).toHaveLength(3)
    expect(files[0].content).toBe("ROOT")
    expect(files[1].content).toBe("MID")
    expect(files[2].content).toBe("LEAF")
  })

  it("does not duplicate an ancestor that is also the home context", async () => {
    const root = await trackedTempDir()
    await writeFile(join(root, "AGENTS.md"), "ROOT", "utf8")
    const child = join(root, "sub")
    await mkdir(child, { recursive: true })
    await writeFile(join(child, "AGENTS.md"), "CHILD", "utf8")

    const previousHome = process.env.HOME
    let files: ReturnType<typeof loadProjectContext>
    try {
      process.env.HOME = root
      files = loadProjectContext(child)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }

    expect(files.map((file) => file.path)).toEqual([
      join(root, "AGENTS.md"),
      join(child, "AGENTS.md"),
    ])
  })

  it("reads another agent's instructions where a folder has no AGENTS.md, unless told not to", async () => {
    const root = await trackedTempDir()
    await writeFile(join(root, "CLAUDE.md"), "CLAUDE", "utf8")
    const mid = join(root, "mid")
    await mkdir(join(mid, ".github"), { recursive: true })
    await writeFile(join(mid, ".github", "copilot-instructions.md"), "COPILOT", "utf8")
    // AGENTS.md wins over the others in the same folder.
    const leaf = join(mid, "leaf")
    await mkdir(leaf, { recursive: true })
    await writeFile(join(leaf, "AGENTS.md"), "LEAF", "utf8")
    await writeFile(join(leaf, "GEMINI.md"), "GEMINI", "utf8")

    expect(loadProjectContext(leaf).map((file) => file.content)).toEqual([
      "CLAUDE",
      "COPILOT",
      "LEAF",
    ])
    expect(loadProjectContext(leaf, false).map((file) => file.content)).toEqual(["LEAF"])
  })

  it("reads Cursor's always-applied rules without their frontmatter, and its legacy file first", async () => {
    const root = await trackedTempDir()
    const rules = join(root, ".cursor", "rules", "frontend")
    await mkdir(rules, { recursive: true })
    await writeFile(
      join(rules, "style.mdc"),
      "---\ndescription: Style\nalwaysApply: true\n---\nUse 2 spaces.",
      "utf8",
    )
    await writeFile(
      join(root, ".cursor", "rules", "tests.mdc"),
      "---\nglobs: tests/**\nalwaysApply: false\n---\nScoped.",
      "utf8",
    )
    expect(loadProjectContext(root)).toEqual([
      { path: join(rules, "style.mdc"), content: "Use 2 spaces." },
    ])

    await writeFile(join(root, ".cursorrules"), "LEGACY", "utf8")
    expect(loadProjectContext(root).map((file) => file.content)).toEqual(["LEGACY"])
  })

  it("falls back to the agents' own global files when the home folder has no instructions", async () => {
    const home = await trackedTempDir()
    const cwd = join(home, "work")
    await mkdir(join(home, "config", "claude"), { recursive: true })
    await mkdir(join(home, ".codex"), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(join(home, "config", "claude", "CLAUDE.md"), "GLOBAL CLAUDE", "utf8")
    await writeFile(join(home, ".codex", "AGENTS.md"), "GLOBAL CODEX", "utf8")
    const previous = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
    try {
      process.env.HOME = home
      process.env.CLAUDE_CONFIG_DIR = join(home, "config", "claude")
      expect(loadProjectContext(cwd).map((file) => file.content)).toEqual(["GLOBAL CLAUDE"])
      expect(loadProjectContext(cwd, false)).toEqual([])
      // The user's own file in the home folder comes first.
      await writeFile(join(home, "AGENTS.md"), "HOME", "utf8")
      expect(loadProjectContext(cwd).map((file) => file.content)).toEqual(["HOME"])
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it("skips empty AGENTS.md files", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "AGENTS.md"), "   \n\n  ", "utf8")
    await writeFile(join(cwd, "PROJECT.md"), "# Project rules", "utf8")

    expect(loadProjectContext(cwd)).toEqual([])
  })
})

async function trackedTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "otis-context-"))
  tempDirs.push(dir)
  return dir
}
