import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { minimalDocx, minimalPdf } from "./support/document-fixtures.js"

const exec = promisify(execFile)

describe("bundled document extraction", () => {
  it.each([
    "compiled",
    "cjs",
  ])("reads PDF and DOCX from the %s bundle without adjacent worker assets", async (format) => {
    const directory = await mkdtemp(join(tmpdir(), "otis-document-bundle-"))
    try {
      const entry = resolve("tests/inference/support/read-document.ts")
      const bundle = join(directory, format === "compiled" ? "reader" : "reader.cjs")
      await exec("bun", [
        "build",
        entry,
        "--outfile",
        bundle,
        ...(format === "compiled" ? ["--compile"] : ["--target=node", "--format=cjs"]),
      ])
      for (const [name, bytes, expected] of [
        ["report.pdf", minimalPdf("Bundled PDF text"), { text: "[Page 1]\nBundled PDF text", pages: 1 }],
        ["report.docx", await minimalDocx("Bundled Word text"), { text: "Bundled Word text" }],
      ] as const) {
        const path = join(directory, name)
        await writeFile(path, bytes)
        const result = await exec(
          format === "compiled" ? bundle : "node",
          format === "compiled" ? [path] : [bundle, path],
          { cwd: directory },
        )
        // PDF.js may diagnose its optional rendering dependencies; extraction itself needs no canvas.
        expect(result.stdout).toContain(JSON.stringify(expected))
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
