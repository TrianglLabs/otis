import { mkdtemp, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ArtifactStore } from "../../src/app/artifacts.js"
import { TranscriptStore } from "../../src/app/transcript.js"
import { ArtifactPublisher, loadPublishedArtifact } from "../../src/artifacts/publisher.js"
import {
  type ArtifactMetadata,
  attachmentArtifactReference,
  type FileArtifactReference,
} from "../../src/artifacts/types.js"
import { MAX_PDF_PAGES } from "../../src/inference/document-constraints.js"
import { createDocumentAttachment } from "../../src/inference/documents.js"
import type { ChatMessage } from "../../src/inference/types.js"
import type { SessionToolActivity } from "../../src/storage/index.js"
import { pdfFixture } from "../desktop/ui/pdf-fixture.js"
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
    const store = new ArtifactStore(cwd, undefined, 50)
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
      await new Promise((resolve) => setTimeout(resolve, 150))
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

  it("keeps the revision for an unchanged selection and reads the current file for it", async () => {
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

    // Reopening the same file is not a new revision; the preview reads the current content.
    await writeFile(path, "# Updated\n", "utf8")
    artifacts.openWorkspace({ source: "workspace", path: "notes.md", kind: "markdown" })
    expect(artifacts.metadata?.revision).toBe(1)
    await expect(artifacts.load(1)).resolves.toMatchObject({ content: "# Updated\n" })
    await expect(artifacts.exportFile(1)).resolves.toEqual({
      name: "notes.md",
      bytes: Buffer.from("# Updated\n"),
    })
    await writeFile(join(cwd, "other.md"), "# Other\n", "utf8")
    artifacts.openWorkspace({ source: "workspace", path: "other.md", kind: "markdown" })
    expect(artifacts.metadata?.revision).toBe(2)
    await expect(artifacts.load(1)).resolves.toBeUndefined()
    await expect(artifacts.exportFile(1)).resolves.toBeUndefined()
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
      encoding: "bytes",
      title: "report.pdf",
      editable: false,
    })
    if (pdfPayload?.kind !== "pdf") throw new Error("Expected PDF bytes")
    expect(pdfPayload.content).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(pdfPayload.content).subarray(0, 5).toString()).toBe("%PDF-")

    const docx = await createDocumentAttachment(
      await minimalDocx("Native Word preview"),
      "brief.docx",
    )
    artifacts.observeMessage({ role: "user", content: [docx] })
    expect(artifacts.metadata?.title).toBe("report.pdf")
    expect(artifacts.open(attachmentArtifactReference(docx))).toBe(true)
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

  it("does not advance the revision for a stat change that leaves the content unchanged", async () => {
    const cwd = await trackedTempDir()
    const path = join(cwd, "notes.md")
    await writeFile(path, "Same content")
    const store = new ArtifactStore(cwd, undefined, 50)
    const unsubscribe = store.subscribe(() => {})
    try {
      store.openWorkspace({ source: "workspace", path: "notes.md", kind: "markdown" })
      const revision = store.metadata?.revision ?? 0
      await store.load(revision)
      const touched = new Date(Date.now() + 5_000)
      await utimes(path, touched, touched)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(store.metadata?.revision).toBe(revision)
      await writeFile(path, "Different content")
      await vi.waitFor(() => expect(store.metadata?.revision).toBeGreaterThan(revision), {
        timeout: 2000,
      })
    } finally {
      unsubscribe()
      store.dispose()
    }
  })

  it("shows produced files unless a version is pinned, live and after replay alike", async () => {
    const cwd = await trackedTempDir()
    const directory = join(await trackedTempDir(), "artifacts")
    const publisher = new ArtifactPublisher(directory)
    const source = { name: "report.md", kind: "markdown" as const, path: join(cwd, "report.md") }
    const v1 = await publisher.publish(Buffer.from("v1"), source)
    const v2 = await publisher.publish(Buffer.from("v2"), source, v1.artifactId)
    const v3 = await publisher.publish(Buffer.from("v3"), source, v1.artifactId)
    const brief = await createDocumentAttachment(Buffer.from("# Brief"), "brief.md")
    const late = await createDocumentAttachment(Buffer.from("# Late"), "late.md")
    await writeFile(join(cwd, "draft.md"), "draft")
    const draft: FileArtifactReference = { source: "workspace", path: "draft.md", kind: "markdown" }
    const call = (id: string, name: string) => ({
      role: "assistant" as const,
      content: [{ type: "tool_call" as const, toolCall: { id, name, arguments: "{}" } }],
    })
    const activity = (
      toolCallId: string,
      activityKind: SessionToolActivity["activityKind"],
      artifact: FileArtifactReference,
    ): SessionToolActivity => ({ toolCallId, activityKind, label: toolCallId, artifact })
    const messages: ChatMessage[] = [
      { role: "user", content: [brief] },
      call("read_1", "read"),
      call("write_1", "write"),
      call("publish_1", "publish_artifact"),
      { role: "user", content: [late] },
      call("publish_2", "publish_artifact"),
    ]
    const activities = [
      activity("read_1", "file_read", draft),
      activity("write_1", "file_write", draft),
      activity("publish_1", "file_read", v1),
      activity("publish_2", "file_read", v2),
    ]
    const shown = (metadata: ArtifactMetadata | undefined) => {
      const { revision: _revision, ...rest } = metadata ?? { revision: 0 }
      return rest
    }

    const live = new ArtifactStore(cwd, directory)
    live.observeMessage(messages[0] as Extract<ChatMessage, { role: "user" }>)
    expect(live.metadata?.title).toBe("brief.md")
    live.observeFile(draft, false)
    expect(live.metadata?.title).toBe("brief.md")
    live.observeFile(draft)
    expect(live.metadata?.title).toBe("draft.md")
    live.observeFile(v1)
    expect(live.metadata?.id).toBe(`published:${v1.artifactId}`)
    live.observeMessage(messages[4] as Extract<ChatMessage, { role: "user" }>)
    expect(live.metadata?.id).toBe(`published:${v1.artifactId}`)
    live.observeFile(v2)
    expect(live.metadata?.publication).toMatchObject({
      followingLatest: true,
      reference: { version: 2 },
    })
    const restored = new ArtifactStore(cwd)
    restored.restore(messages, activities, directory)
    expect(shown(restored.metadata)).toEqual(shown(live.metadata))
    expect(restored.open(attachmentArtifactReference(late))).toBe(true)

    // A pinned version keeps the view from newer publications and survives a reload.
    expect(live.open(v1, 1)).toBe(true)
    live.observeFile(v3)
    expect(live.metadata?.publication).toMatchObject({
      followingLatest: false,
      versions: [1, 2, 3],
      reference: { version: 1 },
    })
    await vi.waitFor(() => stat(join(directory, "pinned.json")))
    const withThird = [...messages, call("publish_3", "publish_artifact")]
    const activitiesWithThird = [...activities, activity("publish_3", "file_read", v3)]
    restored.restore(withThird, activitiesWithThird, directory)
    expect(shown(restored.metadata)).toEqual(shown(live.metadata))
    await expect(restored.load(restored.metadata?.revision ?? 0)).resolves.toMatchObject({
      content: "v1",
    })

    // Following latest again clears the pin.
    expect(live.open(v1)).toBe(true)
    await vi.waitFor(() => expect(stat(join(directory, "pinned.json"))).rejects.toThrow())
    restored.restore(withThird, activitiesWithThird, directory)
    expect(restored.metadata?.publication).toMatchObject({
      followingLatest: true,
      reference: { version: 3 },
    })
  })

  it("previews Markdown up to 512 KB while the store and export keep the 2 MB cap", async () => {
    // Renders a 600 KB document three ways and hashes it for publication; slow CI disks need room.
    const cwd = await trackedTempDir()
    const directory = join(await trackedTempDir(), "artifacts")
    const large = Buffer.from(`# Large\n${"x".repeat(600 * 1024)}\n`)
    await writeFile(join(cwd, "large.md"), large)
    await writeFile(join(cwd, "large.html"), large)
    const store = new ArtifactStore(cwd, directory)
    store.openWorkspace({ source: "workspace", path: "large.md", kind: "markdown" })
    await expect(store.load(store.metadata?.revision ?? 0)).rejects.toThrow("too large to preview")
    await expect(store.exportFile(store.metadata?.revision ?? 0)).resolves.toMatchObject({
      name: "large.md",
      bytes: large,
    })
    store.openWorkspace({ source: "workspace", path: "large.html", kind: "html" })
    await expect(store.load(store.metadata?.revision ?? 0)).resolves.toMatchObject({
      kind: "html",
    })
    const published = await new ArtifactPublisher(directory).publish(large, {
      name: "large.md",
      kind: "markdown",
      path: join(cwd, "large.md"),
    })
    await expect(loadPublishedArtifact(published, 1, directory)).rejects.toThrow(
      "too large to preview",
    )
  }, 20_000)

  it("checks the document header and page count before a preview", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "fake.pdf"), "not a pdf at all")
    await writeFile(join(cwd, "fake.docx"), "PK\u0003\u0004 not a package")
    await writeFile(join(cwd, "long.pdf"), pdfFixture(MAX_PDF_PAGES + 1))
    await writeFile(join(cwd, "short.pdf"), pdfFixture(3))
    const store = new ArtifactStore(cwd)
    store.openWorkspace({ source: "workspace", path: "fake.pdf", kind: "pdf" })
    await expect(store.load(store.metadata?.revision ?? 0)).rejects.toThrow("not a PDF file")
    store.openWorkspace({ source: "workspace", path: "fake.docx", kind: "docx" })
    await expect(store.load(store.metadata?.revision ?? 0)).rejects.toThrow()
    store.openWorkspace({ source: "workspace", path: "long.pdf", kind: "pdf" })
    await expect(store.load(store.metadata?.revision ?? 0)).rejects.toThrow(
      `limit is ${MAX_PDF_PAGES}`,
    )
    store.openWorkspace({ source: "workspace", path: "short.pdf", kind: "pdf" })
    await expect(store.load(store.metadata?.revision ?? 0)).resolves.toMatchObject({
      encoding: "bytes",
    })
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
