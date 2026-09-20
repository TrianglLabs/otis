import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { saveArtifactCopy } from "../../../src/desktop/main/artifact-export.js"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "otis-export-"))
  directories.push(root)
  return root
}

it("saves the exact captured bytes at the chosen path and replaces only the approved destination", async () => {
  const root = await setup()
  const path = join(root, "saved.docx")
  const file = { name: "original.docx", bytes: new Uint8Array([0x50, 0x4b, 0, 255, 17]) }
  await writeFile(path, "previous copy")
  expect(
    await saveArtifactCopy(file, async (name) => {
      expect(name).toBe("original.docx")
      return path
    }),
  ).toEqual({ ok: true })
  expect(await readFile(path)).toEqual(Buffer.from(file.bytes))
  expect(await readdir(root)).toEqual(["saved.docx"])
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)
})

it("cancels without writes and refuses extension changes without damaging an existing file", async () => {
  const root = await setup()
  const file = { name: "report.pdf", bytes: Buffer.from("captured PDF") }
  expect(await saveArtifactCopy(file, async () => undefined)).toEqual({ ok: true })
  expect(await readdir(root)).toEqual([])
  const path = join(root, "report.docx")
  await writeFile(path, "original Word file")
  expect(await saveArtifactCopy(file, async () => path)).toMatchObject({
    ok: false,
    reason: expect.stringContaining("extension"),
  })
  expect(await readFile(path, "utf8")).toBe("original Word file")
})

it("cleans up a failed save and reports the failure", async () => {
  const root = await setup()
  const path = join(root, "directory.pdf")
  await mkdir(path)
  expect(await saveArtifactCopy({ name: "report.pdf", bytes: Buffer.from("PDF") }, async () => path)).toMatchObject({
    ok: false,
  })
  expect(await readdir(root)).toEqual(["directory.pdf"])
  expect((await stat(path)).isDirectory()).toBe(true)
})
