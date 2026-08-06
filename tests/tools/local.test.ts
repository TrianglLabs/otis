import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { executeLocalTool } from "../../src/tools/local.js"
import type { ToolContext } from "../../src/tools/types.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("executeLocalTool", () => {
  it("writes files and reads a requested line range", async () => {
    const context = await testContext()

    const write = await executeLocalTool(
      { name: "write", input: { path: "notes.txt", content: "one\ntwo\nthree" } },
      context,
    )
    expect(write.output).toBe("Wrote 13 characters.")

    const read = await executeLocalTool({ name: "read", input: { path: "notes.txt", offset: 2, limit: 1 } }, context)
    expect(read.output).toBe("2: two")
  })

  it("lists directories deterministically and marks nested directories", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "src"))
    await writeFile(join(context.cwd, "README.md"), "hello", "utf8")

    const result = await executeLocalTool({ name: "read", input: { path: "." } }, context)

    expect(result.output).toBe("README.md\nsrc/")
  })

  it("rejects image and binary files instead of decoding them as text", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "screen.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    await writeFile(join(context.cwd, "data.bin"), new Uint8Array([0x01, 0x00, 0x02]))

    await expect(executeLocalTool({ name: "read", input: { path: "screen.png" } }, context)).rejects.toThrow(
      "Attach the image to an Otis prompt instead",
    )
    await expect(executeLocalTool({ name: "read", input: { path: "data.bin" } }, context)).rejects.toThrow(
      "read supports text files only",
    )
  })

  it("edits exactly one occurrence and rejects ambiguous replacements", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "message.txt"), "alpha beta beta", "utf8")

    await expect(
      executeLocalTool({ name: "edit", input: { path: "message.txt", old: "beta", new: "gamma" } }, context),
    ).rejects.toThrow("old string appears multiple times")

    await executeLocalTool({ name: "edit", input: { path: "message.txt", old: "alpha", new: "omega" } }, context)
    await expect(readFile(join(context.cwd, "message.txt"), "utf8")).resolves.toBe("omega beta beta")
  })

  it("generates a unified diff for edits", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "app.ts"), "const a = 1\nconst b = 2\n", "utf8")

    const result = await executeLocalTool(
      { name: "edit", input: { path: "app.ts", old: "const a = 1", new: "const a = 2" } },
      context,
    )

    expect(result.diff).toBeDefined()
    expect(result.diff).toContain("---")
    expect(result.diff).toContain("+++")
    expect(result.diff).toContain("@@")
    expect(result.diff).toContain("-const a = 1")
    expect(result.diff).toContain("+const a = 2")
  })

  it("generates a unified diff when overwriting an existing file via write", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "config.json"), '{"v": 1}', "utf8")

    const result = await executeLocalTool(
      { name: "write", input: { path: "config.json", content: '{"v": 2}' } },
      context,
    )

    expect(result.diff).toBeDefined()
    expect(result.diff).toContain('-{"v": 1}')
    expect(result.diff).toContain('+{"v": 2}')
  })

  it("generates an all-additions diff when writing a new file", async () => {
    const context = await testContext()

    const result = await executeLocalTool(
      { name: "write", input: { path: "new.ts", content: "const x = 1\n" } },
      context,
    )

    expect(result.diff).toBeDefined()
    expect(result.diff).toContain("+++")
    expect(result.diff).toContain("+const x = 1")
    expect(result.diff).not.toContain("-const")
  })

  it("refuses path traversal and symlinks that escape the workspace", async () => {
    const context = await testContext()
    const outsideDir = await trackedTempDir()
    const outsideFile = join(outsideDir, "secret.txt")
    await writeFile(outsideFile, "secret", "utf8")
    await symlink(outsideFile, join(context.cwd, "secret-link.txt"))

    await expect(executeLocalTool({ name: "read", input: { path: "../secret.txt" } }, context)).rejects.toThrow(
      "Path is outside the workspace",
    )
    await expect(executeLocalTool({ name: "read", input: { path: "secret-link.txt" } }, context)).rejects.toThrow(
      "Path is outside the workspace",
    )
  })

  it("runs shell commands through the configured workspace", async () => {
    const context = await testContext()
    const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.cwd())"`

    const result = await executeLocalTool({ name: "bash", input: { command, timeoutMs: 1_000 } }, context)

    expect(result.output).toContain("Exit code: 0.")
    expect(result.output).toContain(context.cwd)
  })
})

describe("grep", () => {
  it("finds matching lines across nested files with relative paths and line numbers", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "src"), { recursive: true })
    await writeFile(join(context.cwd, "src", "a.ts"), "const TODO = 1\nconst done = 2\n", "utf8")
    await writeFile(join(context.cwd, "src", "b.ts"), "const TODO = 3\n", "utf8")
    await writeFile(join(context.cwd, "README.md"), "# TODO list\n", "utf8")

    const result = await executeLocalTool({ name: "grep", input: { pattern: "TODO", path: "." } }, context)

    expect(result.output.split("\n")).toEqual([
      "README.md:1:# TODO list",
      "src/a.ts:1:const TODO = 1",
      "src/b.ts:1:const TODO = 3",
    ])
  })

  it("supports regex patterns", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "f.ts"), "const a = 1\nconst bb = 2\nconst ccc = 3\n", "utf8")

    const result = await executeLocalTool({ name: "grep", input: { pattern: "const \\w{2,} =", path: "." } }, context)

    const lines = result.output.split("\n")
    expect(lines).toContain("f.ts:2:const bb = 2")
    expect(lines).toContain("f.ts:3:const ccc = 3")
    expect(lines).not.toContain("f.ts:1:const a = 1")
  })

  it("filters files by include glob pattern", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "a.ts"), "TODO\n", "utf8")
    await writeFile(join(context.cwd, "b.md"), "TODO\n", "utf8")

    const result = await executeLocalTool(
      { name: "grep", input: { pattern: "TODO", path: ".", include: "*.ts" } },
      context,
    )

    expect(result.output).toContain("a.ts:1:TODO")
    expect(result.output).not.toContain("b.md")
  })

  it("include filter matches files at any depth by basename", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "src", "utils"), { recursive: true })
    await writeFile(join(context.cwd, "src", "utils", "helper.ts"), "TODO\n", "utf8")
    await writeFile(join(context.cwd, "src", "index.ts"), "TODO\n", "utf8")
    await writeFile(join(context.cwd, "src", "notes.md"), "TODO\n", "utf8")

    const result = await executeLocalTool(
      { name: "grep", input: { pattern: "TODO", path: ".", include: "*.ts" } },
      context,
    )

    expect(result.output).toContain("src/utils/helper.ts:1:TODO")
    expect(result.output).toContain("src/index.ts:1:TODO")
    expect(result.output).not.toContain("notes.md")
  })

  it("searches a single file when path points to a file", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "target.ts"), "line one\nline two\n", "utf8")

    const result = await executeLocalTool({ name: "grep", input: { pattern: "two", path: "target.ts" } }, context)

    expect(result.output).toBe("target.ts:2:line two")
  })

  it("returns a no-matches message when nothing matches", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "f.ts"), "nothing here\n", "utf8")

    const result = await executeLocalTool({ name: "grep", input: { pattern: "MISSING", path: "." } }, context)

    expect(result.output).toBe("No matches found.")
  })

  it("respects maxResults and stops early", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "f.ts"), "TODO\nTODO\nTODO\nTODO\nTODO\n", "utf8")

    const result = await executeLocalTool(
      { name: "grep", input: { pattern: "TODO", path: ".", maxResults: 2 } },
      context,
    )

    const lines = result.output.split("\n")
    expect(lines).toHaveLength(2)
  })

  it("skips ignored directories like node_modules", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "node_modules"), { recursive: true })
    await writeFile(join(context.cwd, "node_modules", "dep.ts"), "TODO in deps\n", "utf8")
    await writeFile(join(context.cwd, "app.ts"), "TODO in app\n", "utf8")

    const result = await executeLocalTool({ name: "grep", input: { pattern: "TODO", path: "." } }, context)

    expect(result.output).toContain("app.ts:1:TODO in app")
    expect(result.output).not.toContain("node_modules")
  })

  it("searches relevant dot-directories while still excluding .git", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, ".github"), { recursive: true })
    await mkdir(join(context.cwd, ".git"), { recursive: true })
    await writeFile(join(context.cwd, ".github", "workflow.yml"), "release: true\n", "utf8")
    await writeFile(join(context.cwd, ".git", "config"), "release: hidden\n", "utf8")

    const grep = await executeLocalTool({ name: "grep", input: { pattern: "release", path: "." } }, context)
    const glob = await executeLocalTool({ name: "glob", input: { pattern: "**/*.yml", path: "." } }, context)

    expect(grep.output).toContain(".github/workflow.yml:1:release: true")
    expect(grep.output).not.toContain(".git/config")
    expect(glob.output).toContain(".github/workflow.yml")
  })
})

describe("glob", () => {
  it("finds files matching a pattern recursively", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "src", "utils"), { recursive: true })
    await writeFile(join(context.cwd, "src", "index.ts"), "", "utf8")
    await writeFile(join(context.cwd, "src", "utils", "helper.ts"), "", "utf8")
    await writeFile(join(context.cwd, "README.md"), "", "utf8")

    const result = await executeLocalTool({ name: "glob", input: { pattern: "**/*.ts", path: "." } }, context)

    expect(result.output.split("\n")).toEqual(["src/index.ts", "src/utils/helper.ts"])
  })

  it("matches files in the root directory with a simple pattern", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "a.ts"), "", "utf8")
    await writeFile(join(context.cwd, "b.ts"), "", "utf8")
    await mkdir(join(context.cwd, "src"))
    await writeFile(join(context.cwd, "src", "c.ts"), "", "utf8")

    const result = await executeLocalTool({ name: "glob", input: { pattern: "*.ts", path: "." } }, context)

    expect(result.output.split("\n")).toEqual(["a.ts", "b.ts"])
  })

  it("scopes the search to a subdirectory via path", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "src"), { recursive: true })
    await writeFile(join(context.cwd, "src", "a.ts"), "", "utf8")
    await writeFile(join(context.cwd, "root.ts"), "", "utf8")

    const result = await executeLocalTool({ name: "glob", input: { pattern: "*.ts", path: "src" } }, context)

    expect(result.output).toBe("a.ts")
  })

  it("returns a no-files message when nothing matches", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "a.txt"), "", "utf8")

    const result = await executeLocalTool({ name: "glob", input: { pattern: "**/*.ts", path: "." } }, context)

    expect(result.output).toBe("No files matched.")
  })

  it("respects maxResults and stops early", async () => {
    const context = await testContext()
    for (let i = 0; i < 10; i++) {
      await writeFile(join(context.cwd, `file${i}.ts`), "", "utf8")
    }

    const result = await executeLocalTool(
      { name: "glob", input: { pattern: "*.ts", path: ".", maxResults: 3 } },
      context,
    )

    const paths = result.output.split("\n")
    expect(paths).toHaveLength(3)
  })

  it("skips ignored directories like node_modules", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "node_modules", "dep"), { recursive: true })
    await writeFile(join(context.cwd, "node_modules", "dep", "index.ts"), "", "utf8")
    await writeFile(join(context.cwd, "app.ts"), "", "utf8")

    const result = await executeLocalTool({ name: "glob", input: { pattern: "**/*.ts", path: "." } }, context)

    expect(result.output).toContain("app.ts")
    expect(result.output).not.toContain("node_modules")
  })
})

async function testContext(): Promise<Required<Pick<ToolContext, "cwd">>> {
  return { cwd: await trackedTempDir() }
}

async function trackedTempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-tools-"))
  tempDirs.push(path)
  return path
}
