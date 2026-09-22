import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ArtifactStore } from "../../src/app/artifacts.js"
import { TranscriptStore } from "../../src/app/transcript.js"
import { attachmentArtifactReference } from "../../src/artifacts/types.js"
import { createDocumentAttachment } from "../../src/inference/documents.js"
import type { ChatMessage } from "../../src/inference/types.js"
import { minimalDocx, minimalPdf } from "../inference/support/document-fixtures.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("ArtifactStore", () => {
  it("refreshes the selected working file after external replacement, deletion, and recreation", async () => {
    const cwd = await trackedTempDir()
    const path = join(cwd, "notes.md")
    await writeFile(path, "First")
    const store = new ArtifactStore(cwd)
    const changed = vi.fn()
    const unsubscribe = store.subscribe(changed)
    try {
      store.openWorkspace({ source: "workspace", path: "notes.md", kind: "markdown" })
      const initial = store.metadata?.revision ?? 0
      await writeFile(join(cwd, "replacement.md"), "Replaced externally")
      await rename(join(cwd, "replacement.md"), path)
      await vi.waitFor(() => expect(store.metadata?.revision).toBeGreaterThan(initial), {
        timeout: 2000,
      })
      await expect(store.load(store.metadata?.revision ?? 0)).resolves.toMatchObject({
        content: "Replaced externally",
      })
      const replaced = store.metadata?.revision ?? 0
      await rm(path)
      await vi.waitFor(() => expect(store.metadata?.revision).toBeGreaterThan(replaced), {
        timeout: 2000,
      })
      await expect(store.load(store.metadata?.revision ?? 0)).rejects.toThrow("moved or deleted")
      const deleted = store.metadata?.revision ?? 0
      await writeFile(path, "Recreated")
      await vi.waitFor(() => expect(store.metadata?.revision).toBeGreaterThan(deleted), {
        timeout: 2000,
      })
      await expect(store.load(store.metadata?.revision ?? 0)).resolves.toMatchObject({
        content: "Recreated",
      })
      store.clear()
      const cleared = changed.mock.calls.length
      await writeFile(path, "After clearing")
      expect(store.metadata).toBeUndefined()
      unsubscribe()
      store.dispose()
      await writeFile(path, "After disposal")
      await new Promise((resolve) => setTimeout(resolve, 650))
      expect(changed.mock.calls.length).toBe(cleared)
    } finally {
      unsubscribe()
      store.dispose()
    }
  })

  it("drops an in-flight preview when the session is cleared", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "notes.md"), "Old session")
    const store = new ArtifactStore(cwd)
    store.openWorkspace({ source: "workspace", path: "notes.md", kind: "markdown" })
    const pending = store.load(store.metadata?.revision ?? 0)
    const exportPending = store.exportFile(store.metadata?.revision ?? 0)
    store.clear()
    await expect(pending).resolves.toBeUndefined()
    await expect(exportPending).resolves.toBeUndefined()
  })

  it("retains code and data sources without opening Canvas or displacing a visual document", async () => {
    const cwd = await trackedTempDir()
    const store = new ArtifactStore(cwd)
    const visual = await createDocumentAttachment(Buffer.from("# Brief"), "brief.md")
    const code = await createDocumentAttachment(Buffer.from("print('hello')"), "main.py")
    const config = await createDocumentAttachment(Buffer.from('{"enabled":true}'), "config.json")
    const raw = await createDocumentAttachment(Buffer.from("plain text"), "notes.txt")
    const source = { role: "user" as const, content: [visual, code, config, raw] }
    store.observeMessage({ role: "user", content: [code, config, raw] })
    expect(store.metadata).toBeUndefined()
    store.observeMessage(source)
    expect(store.metadata?.title).toBe("brief.md")
    const revision = store.metadata?.revision
    for (const document of [code, config, raw])
      expect(store.open(attachmentArtifactReference(document))).toBe(false)
    store.observeFile({ source: "workspace", kind: "text", path: "notes.txt" })
    expect(store.metadata?.revision).toBe(revision)
    store.restore([source], [])
    expect(store.metadata?.title).toBe("brief.md")
    expect(store.attachments).toEqual(expect.arrayContaining([visual, code, config, raw]))
  })

  it("keeps every attachment available after compaction and restores them from full scrollback", async () => {
    const cwd = await trackedTempDir()
    const first = await createDocumentAttachment(
      new TextEncoder().encode("First source"),
      "first.md",
    )
    const second = await createDocumentAttachment(
      new TextEncoder().encode("Second source"),
      "second.md",
    )
    const message = { role: "user" as const, content: [first, second] }
    const transcript = new TranscriptStore()
    const artifacts = new ArtifactStore(cwd)
    transcript.loadMessages([message])
    artifacts.observeMessage(message)
    transcript.loadCompacted("Summary only", [])
    expect(transcript.history).not.toContain(message)
    expect(artifacts.open(attachmentArtifactReference(first))).toBe(true)
    await expect(artifacts.load(artifacts.metadata?.revision ?? 0)).resolves.toMatchObject({
      content: "First source",
    })
    expect(artifacts.open({ ...attachmentArtifactReference(first), name: "wrong.md" })).toBe(false)

    artifacts.clear()
    expect(artifacts.open(attachmentArtifactReference(first))).toBe(false)
    artifacts.restore([message], [])
    expect(artifacts.open(attachmentArtifactReference(first))).toBe(true)
    expect(artifacts.open(attachmentArtifactReference(second))).toBe(true)
  })

  it("loads the current workspace file by revision and reflects later edits", async () => {
    const cwd = await trackedTempDir()
    const path = join(cwd, "notes.md")
    await writeFile(path, "# First\n", "utf8")
    const artifacts = new ArtifactStore(cwd)

    artifacts.openWorkspace({ source: "workspace", path: "notes.md", kind: "markdown" })
    const first = artifacts.metadata
    expect(first).toMatchObject({ title: "notes.md", editable: true, revision: 1 })
    await expect(artifacts.load(first?.revision ?? 0)).resolves.toMatchObject({
      encoding: "utf8",
      content: "# First\n",
    })

    await writeFile(path, "# Updated\n", "utf8")
    artifacts.openWorkspace({ source: "workspace", path: "notes.md", kind: "markdown" })
    const updated = artifacts.metadata
    expect(updated?.revision).toBe(2)
    await expect(artifacts.load(first?.revision ?? 0)).resolves.toBeUndefined()
    await expect(artifacts.load(updated?.revision ?? 0)).resolves.toMatchObject({
      content: "# Updated\n",
    })
    await expect(artifacts.exportFile(first?.revision ?? 0)).resolves.toBeUndefined()
    await expect(artifacts.exportFile(updated?.revision ?? 0)).resolves.toEqual({
      name: "notes.md",
      bytes: Buffer.from("# Updated\n"),
    })
  })

  it("renders original PDF and DOCX bytes without flattening the stored source", async () => {
    const cwd = await trackedTempDir()
    const artifacts = new ArtifactStore(cwd)
    const pdf = await createDocumentAttachment(minimalPdf("Canvas PDF"), "report.pdf")
    artifacts.observeMessage({
      role: "user",
      content: [{ type: "text", text: "Review this" }, pdf],
    })
    const pdfPayload = await artifacts.load(artifacts.metadata?.revision ?? 0)
    expect(pdfPayload).toMatchObject({
      kind: "pdf",
      encoding: "base64",
      title: "report.pdf",
      editable: false,
    })
    expect(
      Buffer.from(pdfPayload?.content ?? "", "base64")
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-")

    const docx = await createDocumentAttachment(
      await minimalDocx("Native Word preview"),
      "brief.docx",
    )
    artifacts.observeMessage({ role: "user", content: [docx] })
    await expect(artifacts.load(artifacts.metadata?.revision ?? 0)).resolves.toMatchObject({
      kind: "docx",
      encoding: "html",
      content: "<p>Native Word preview</p>",
    })
    await expect(artifacts.exportFile(artifacts.metadata?.revision ?? 0)).resolves.toEqual({
      name: "brief.docx",
      bytes: Buffer.from(docx.data, "base64"),
    })
  })

  it("restores the last artifact in transcript order and rejects unsafe references", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "result.html"), "<h1>Result</h1>", "utf8")
    const attachment = await createDocumentAttachment(new TextEncoder().encode("Draft"), "draft.md")
    const messages: ChatMessage[] = [
      { role: "user", content: [attachment] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolCall: {
              id: "write_1",
              name: "write",
              arguments: '{"path":"result.html","content":"..."}',
            },
          },
        ],
      },
      { role: "tool", toolCallId: "write_1", content: "written" },
    ]
    const artifacts = new ArtifactStore(cwd)
    artifacts.restore(messages, [
      {
        toolCallId: "write_1",
        activityKind: "file_edit",
        label: "Writing file: result.html",
        artifact: { source: "workspace", path: "result.html", kind: "html" },
      },
    ])
    expect(artifacts.metadata).toMatchObject({
      source: "workspace",
      path: "result.html",
      kind: "html",
    })
    expect(() =>
      artifacts.openWorkspace({ source: "workspace", path: "../outside.md", kind: "markdown" }),
    ).toThrow("Invalid workspace artifact reference")
  })

  it("refuses a workspace artifact whose path became an escaping symlink", async () => {
    const cwd = await trackedTempDir()
    const outside = await trackedTempDir()
    await writeFile(join(outside, "secret.md"), "secret", "utf8")
    await symlink(join(outside, "secret.md"), join(cwd, "preview.md"))
    const artifacts = new ArtifactStore(cwd)
    artifacts.openWorkspace({ source: "workspace", path: "preview.md", kind: "markdown" })

    await expect(artifacts.load(artifacts.metadata?.revision ?? 0)).rejects.toThrow(
      "outside the workspace",
    )
    await expect(artifacts.exportFile(artifacts.metadata?.revision ?? 0)).rejects.toThrow(
      "outside the workspace",
    )
  })
})

async function trackedTempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-artifacts-"))
  tempDirs.push(path)
  return path
}
