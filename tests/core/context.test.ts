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

    expect(files.map((file) => file.path)).toEqual([join(root, "AGENTS.md"), join(child, "AGENTS.md")])
  })

  it("skips empty AGENTS.md files", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "AGENTS.md"), "   \n\n  ", "utf8")

    expect(loadProjectContext(cwd)).toEqual([])
  })

  it("ignores unrelated markdown files when AGENTS.md is empty", async () => {
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
