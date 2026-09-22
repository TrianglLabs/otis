import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ArtifactStore } from "../../src/app/artifacts.js"
import type { DocumentContentPart } from "../../src/inference/types.js"
import { createPermissionPolicy } from "../../src/permissions/policy.js"
import { executeToolCall, type ToolContext } from "../../src/tools/index.js"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function document(name = "notes.txt", value = "original text"): DocumentContentPart {
  const bytes = Buffer.from(value)
  return {
    type: "document",
    kind: "text",
    name,
    mimeType: "text/plain",
    data: bytes.toString("base64"),
    sizeBytes: bytes.length,
    extractedText: value,
    truncated: false,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "otis-attachments-"))
  directories.push(path)
  return path
}

function save(input: { attachment: string; path: string }, context: ToolContext) {
  return executeToolCall({ name: "save_attachment", input }, context)
}

describe("save_attachment", () => {
  it("writes original bytes privately, emits a Canvas reference, and never overwrites", async () => {
    const cwd = await directory()
    const attachment = document()
    const context = { cwd, attachments: () => [attachment, attachment] }
    const call = {
      name: "save_attachment",
      input: { attachment: attachment.sha256, path: "copy.txt" },
    } as const
    const result = await executeToolCall(call, context)
    expect(await readFile(join(cwd, "copy.txt"), "utf8")).toBe("original text")
    expect(result.artifact).toBeUndefined()
    if (process.platform !== "win32")
      expect((await stat(join(cwd, "copy.txt"))).mode & 0o777).toBe(0o600)
    await expect(executeToolCall(call, context)).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readdir(cwd)).toEqual(["copy.txt"])
  })

  it("resolves duplicate filenames by content identity and rejects corruption or format changes", async () => {
    const cwd = await directory()
    const first = document("notes.txt", "first")
    const second = document("notes.txt", "second")
    const context = { cwd, attachments: () => [first, second] }
    await expect(save({ attachment: "notes.txt", path: "copy.txt" }, context)).rejects.toThrow(
      "ambiguous",
    )
    await save({ attachment: first.sha256, path: "first.txt" }, context)
    expect(await readFile(join(cwd, "first.txt"), "utf8")).toBe("first")
    await expect(save({ attachment: first.sha256, path: "copy.pdf" }, context)).rejects.toThrow(
      "does not convert",
    )
    await expect(save({ attachment: "missing", path: "copy.txt" }, context)).rejects.toThrow(
      "not found",
    )
    await expect(
      save(
        { attachment: first.sha256, path: "copy.txt" },
        {
          cwd,
          attachments: () => [{ ...first, data: Buffer.from("other").toString("base64") }],
        },
      ),
    ).rejects.toThrow("SHA-256")
    expect(await readdir(cwd)).toEqual(["first.txt"])
  })

  it("enforces workspace boundaries and cancellation", async () => {
    const cwd = await directory()
    const outside = await directory()
    const attachment = document()
    await symlink(outside, join(cwd, "outside"))
    const context = { cwd, attachments: () => [attachment] }
    await expect(
      save({ attachment: attachment.name, path: "outside/copy.txt" }, context),
    ).rejects.toThrow("outside")
    const controller = new AbortController()
    controller.abort()
    await expect(
      save(
        { attachment: attachment.name, path: "copy.txt" },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toThrow()
    expect(await readdir(outside)).toEqual([])
  })

  it("uses write permissions and matches both lexical and canonical paths", async () => {
    const cwd = await directory()
    await writeFile(join(cwd, "protected.txt"), "existing")
    await symlink(join(cwd, "protected.txt"), join(cwd, "alias.txt"))
    const call = {
      name: "save_attachment",
      input: { attachment: "notes.txt", path: "alias.txt" },
    } as const
    expect(await createPermissionPolicy({ cwd, mode: "dontAsk" }).evaluate(call)).toMatchObject({
      effect: "deny",
    })
    expect(await createPermissionPolicy({ cwd, mode: "ask" }).evaluate(call)).toMatchObject({
      effect: "ask",
    })
    expect(
      await createPermissionPolicy({
        cwd,
        mode: "auto",
        rules: [{ tool: "save_attachment", resource: "protected.txt", effect: "deny" }],
      }).evaluate(call),
    ).toMatchObject({ effect: "deny" })
  })

  it("retains session originals independently of model context and clears them on session reset", async () => {
    const cwd = await directory()
    const source = document()
    const store = new ArtifactStore(cwd)
    store.restore([{ role: "user", content: [source] }], [])
    await save(
      { attachment: source.sha256, path: "restored.txt" },
      { cwd, attachments: () => store.attachments },
    )
    expect(await readFile(join(cwd, "restored.txt"), "utf8")).toBe(source.extractedText)
    store.clear()
    await expect(
      save(
        { attachment: source.sha256, path: "missing.txt" },
        { cwd, attachments: () => store.attachments },
      ),
    ).rejects.toThrow("not found")
  })
})
