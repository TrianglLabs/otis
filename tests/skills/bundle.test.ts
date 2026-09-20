import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const exec = promisify(execFile)
describe("document skill release assets", () => {
  it.each(["compiled", "cjs"])("loads helpers from a %s bundle outside the source tree", async (format) => {
    const directory = await mkdtemp(join(tmpdir(), "otis-skill-bundle-"))
    try {
      const entry = resolve("tests/skills/support/load-bundled.ts")
      const bundle = join(directory, format === "compiled" ? "reader" : "reader.cjs")
      await exec("bun", [
        "build",
        entry,
        "--outfile",
        bundle,
        ...(format === "compiled" ? ["--compile"] : ["--target=node", "--format=cjs"]),
      ])
      const args = [join(directory, "private")]
      const result = await exec(
        format === "compiled" ? bundle : "node",
        format === "compiled" ? args : [bundle, ...args],
        { cwd: directory },
      )
      const { root } = JSON.parse(result.stdout) as { root: string }
      expect(await readFile(join(root, "document.py"), "utf8")).toBe(
        await readFile(resolve("src/skills/bundled/documents/document.py"), "utf8"),
      )
      expect(await readFile(join(root, "pdf_edit.py"), "utf8")).toBe(
        await readFile(resolve("src/skills/bundled/documents/pdf_edit.py"), "utf8"),
      )
      expect(await readFile(join(root, "requirements.txt"), "utf8")).toContain("python-docx==")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
