import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const exec = promisify(execFile)
describe("document skill release assets", () => {
  it.each([
    "compiled",
    "cjs",
    "desktop",
  ])("loads helpers from a %s bundle outside the source tree", async (format) => {
    const directory = await mkdtemp(join(tmpdir(), "otis-skill-bundle-"))
    try {
      const entry = resolve("tests/skills/support/load-bundled.ts")
      const bundle = join(directory, format === "compiled" ? "reader" : "reader.cjs")
      if (format === "desktop") {
        await exec("bun", [resolve("tests/skills/support/build-desktop.ts"), bundle])
      } else {
        await exec("bun", [
          "build",
          entry,
          "--outfile",
          bundle,
          ...(format === "compiled" ? ["--compile"] : ["--target=node", "--format=cjs"]),
        ])
      }
      const args = [join(directory, "private")]
      const result = await exec(
        format === "compiled" ? bundle : "node",
        format === "compiled" ? args : [bundle, ...args],
        { cwd: directory },
      )
      const { root, systemPrompt } = JSON.parse(result.stdout) as {
        root: string
        systemPrompt: string
      }
      for (const name of [
        "SKILL.md",
        "spec.md",
        "document.py",
        "pdf_edit.py",
        "requirements.txt",
      ]) {
        expect(await readFile(join(root, name), "utf8"), name).toBe(
          await readFile(resolve("src/skills/bundled/documents", name), "utf8"),
        )
      }
      const prompt = await readFile(resolve("src/inference/system-prompt.txt"), "utf8")
      expect(systemPrompt.slice(0, prompt.trim().length)).toBe(prompt.trim())
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
