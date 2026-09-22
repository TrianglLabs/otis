import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ArtifactStore, sessionArtifactPublisher } from "../../src/app/artifacts.js"
import { loadPublishedArtifact } from "../../src/artifacts/publisher.js"
import {
  isPublishedArtifactReference,
  type PublishedArtifactReference,
} from "../../src/artifacts/types.js"
import { MAX_RAW_DOCUMENT_BYTES } from "../../src/inference/documents.js"
import { createPermissionPolicy } from "../../src/permissions/policy.js"
import { deleteSession, openSession } from "../../src/storage/session.js"
import { executeToolCall } from "../../src/tools/index.js"
import type { ToolContext } from "../../src/tools/types.js"
import { minimalDocx, minimalPdf } from "../inference/support/document-fixtures.js"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "otis-publication-")))
  directories.push(root)
  const cwd = join(root, "workspace")
  await mkdir(cwd)
  const session = await openSession({ cwd, directory: join(root, "sessions") })
  return {
    root,
    cwd,
    session,
    artifactDirectory: session.artifactDirectory,
    artifactPublisher: sessionArtifactPublisher(session),
  }
}

async function publish(path: string, context: ToolContext, artifactId?: string) {
  const result = await executeToolCall(
    { name: "publish_artifact", input: { path, artifactId } },
    context,
  )
  expect(result.artifact?.source).toBe("published")
  return result.artifact as PublishedArtifactReference
}

describe("artifact publication", () => {
  it("keeps one identity across moves, follows latest, and preserves a user's pinned revision", async () => {
    const context = await setup()
    const path = join(context.cwd, "first.md")
    await writeFile(path, "First")
    const first = await publish(path, context)
    const store = new ArtifactStore(context.cwd, context.artifactDirectory)
    store.observeFile(first)
    const id = store.metadata?.id
    const moved = join(context.cwd, "renamed.md")
    await rename(path, moved)
    await writeFile(moved, "Second")
    const second = await publish(moved, context, first.artifactId)
    store.observeFile(second)
    expect(store.metadata).toMatchObject({
      id,
      title: "renamed.md",
      publication: {
        versions: [1, 2],
        followingLatest: true,
        reference: { artifactId: first.artifactId, version: 2 },
      },
    })
    await expect(store.load(store.metadata?.revision ?? 0)).resolves.toMatchObject({
      content: "Second",
    })
    expect(store.open(first, 1)).toBe(true)
    const third = await context.artifactPublisher.publish(
      Buffer.from("Third"),
      { name: "renamed.md", kind: "markdown", path: moved },
      first.artifactId,
    )
    store.observeFile(third)
    expect(store.metadata).toMatchObject({
      id,
      title: "first.md",
      publication: { versions: [1, 2, 3], followingLatest: false, reference: { version: 1 } },
    })
    await expect(store.load(store.metadata?.revision ?? 0)).resolves.toMatchObject({
      content: "First",
    })
    await expect(store.exportFile(store.metadata?.revision ?? 0)).resolves.toEqual({
      name: "first.md",
      bytes: Buffer.from("First"),
    })
    expect(store.open(first, 99)).toBe(false)
    expect(store.open(first)).toBe(true)
    await expect(store.load(store.metadata?.revision ?? 0)).resolves.toMatchObject({
      content: "Third",
    })
    // A newly published artifact takes the view while following latest, never while pinned.
    const unrelated = await publish(moved, context)
    expect(unrelated.artifactId).not.toBe(first.artifactId)
    store.observeFile(unrelated)
    expect(store.metadata?.id).toBe(`published:${unrelated.artifactId}`)
    expect(store.open(first, 1)).toBe(true)
    store.observeFile(unrelated)
    expect(store.metadata).toMatchObject({ id, publication: { reference: { version: 1 } } })
    await expect(publish(moved, context, "unknown-id")).rejects.toThrow("Unknown artifact_id")
    await expect(
      context.artifactPublisher.publish(
        Buffer.from("<h1>HTML</h1>"),
        { name: "renamed.html", kind: "html", path: moved },
        first.artifactId,
      ),
    ).rejects.toThrow("different file type")
  })

  it("deletes only the owning session's copies, including unpublished leftovers, without deleting source files", async () => {
    const context = await setup()
    const source = join(context.cwd, "notes.md")
    await writeFile(source, "Shared content")
    const first = await publish(source, context)
    const other = await openSession({
      cwd: context.cwd,
      directory: join(context.root, "sessions"),
      sessionId: "other",
    })
    const second = await publish(source, {
      cwd: context.cwd,
      artifactPublisher: sessionArtifactPublisher(other),
    })
    expect(first.sha256).toBe(second.sha256)
    await writeFile(join(context.artifactDirectory, "interrupted.tmp"), "incomplete")
    await deleteSession({
      cwd: context.cwd,
      directory: join(context.root, "sessions"),
      sessionId: context.session.id,
    })
    await expect(stat(context.session.filePath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(context.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(loadPublishedArtifact(second, 1, other.artifactDirectory)).resolves.toMatchObject({
      content: "Shared content",
    })
    expect(await readFile(source, "utf8")).toBe("Shared content")
  })

  it("loads publication IDs from full history for the next turn after compaction and rejects IDs from other sessions", async () => {
    const context = await setup()
    const source = join(context.cwd, "notes.md")
    await writeFile(source, "First")
    const first = await publish(source, context)
    const admission = await context.session.admitPrompt("Publish")
    await context.session.completeTurn(
      admission,
      [
        admission.message,
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              toolCall: { id: "pub1", name: "publish_artifact", arguments: '{"path":"notes.md"}' },
            },
          ],
        },
        { role: "tool", toolCallId: "pub1", content: "Published" },
      ],
      {
        toolActivities: [
          { toolCallId: "pub1", activityKind: "file_read", label: "Published", artifact: first },
        ],
      },
    )
    await context.session.compact("Published notes", [])
    const reopened = await openSession({
      cwd: context.cwd,
      directory: join(context.root, "sessions"),
    })
    await writeFile(source, "Next turn")
    const second = await publish(
      source,
      { cwd: context.cwd, artifactPublisher: sessionArtifactPublisher(reopened) },
      first.artifactId,
    )
    expect(second).toMatchObject({ artifactId: first.artifactId, version: 2 })
    const other = await openSession({
      cwd: context.cwd,
      directory: join(context.root, "sessions"),
      sessionId: "other",
    })
    await expect(
      publish(
        source,
        { cwd: context.cwd, artifactPublisher: sessionArtifactPublisher(other) },
        first.artifactId,
      ),
    ).rejects.toThrow("Unknown artifact_id")
    await expect(
      executeToolCall({ name: "publish_artifact", input: { path: source } }, { cwd: context.cwd }),
    ).rejects.toThrow("requires a saved session")
  })

  it("publishes shell-moved output, preserves versions, and restores the final card after restart and compaction", async () => {
    const context = await setup()
    const staged = join(context.cwd, "staging.html")
    const final = join(context.root, "final.html")
    const original = await executeToolCall(
      { name: "write", input: { path: staged, content: "<h1>First</h1>" } },
      context,
    )
    const artifacts = new ArtifactStore(context.cwd, context.artifactDirectory)
    if (!original.artifact) throw new Error("Expected a working-file artifact")
    artifacts.observeFile(original.artifact)
    await executeToolCall(
      { name: "bash", input: { command: "mv staging.html ../final.html" } },
      context,
    )
    await expect(artifacts.load(artifacts.metadata?.revision ?? 0)).rejects.toThrow(
      "may have been moved or deleted",
    )

    const decision = await createPermissionPolicy({ cwd: context.cwd, mode: "auto" }).evaluate({
      name: "publish_artifact",
      input: { path: final },
    })
    expect(decision.effect).toBe("ask")
    const first = await publish(final, {
      ...context,
      authorizedArtifactPath: decision.artifactPath,
    })
    expect(await readFile(final, "utf8")).toBe("<h1>First</h1>")
    await writeFile(final, "<h1>Final</h1>")
    const second = await publish(
      final,
      { ...context, authorizedArtifactPath: decision.artifactPath },
      first.artifactId,
    )
    expect(second.artifactId).toBe(first.artifactId)
    expect(second.version).toBe(2)
    expect(second.sha256).not.toBe(first.sha256)
    await rename(final, join(context.root, "renamed.html"))
    await rm(join(context.root, "renamed.html"))

    const options = { cwd: context.cwd, directory: join(context.root, "sessions") }
    const session = await openSession(options)
    const admission = await session.admitPrompt("Make a page")
    const references = [first, second]
    const messages = references.flatMap((_, index) => [
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_call" as const,
            toolCall: {
              id: `publish_${index}`,
              name: "publish_artifact",
              arguments: JSON.stringify({ path: final }),
            },
          },
        ],
      },
      { role: "tool" as const, toolCallId: `publish_${index}`, content: "Published" },
    ])
    await session.completeTurn(admission, [admission.message, ...messages], {
      toolActivities: references.map((artifact, index) => ({
        toolCallId: `publish_${index}`,
        label: "Published final.html",
        activityKind: "file_read",
        artifact,
      })),
    })
    await session.compact("Made a page", [])
    const reopened = await openSession(options)
    const replay = reopened.replayTranscript()
    const restored = new ArtifactStore(context.cwd, context.artifactDirectory)
    restored.restore(replay.messages, replay.toolActivities)
    expect(restored.metadata).toMatchObject({
      source: "published",
      title: "final.html",
      editable: false,
    })
    await expect(restored.load(restored.metadata?.revision ?? 0)).resolves.toMatchObject({
      content: "<h1>Final</h1>",
    })
    expect(restored.open(first)).toBe(true)
    await expect(restored.load(restored.metadata?.revision ?? 0)).resolves.toMatchObject({
      content: "<h1>Final</h1>",
    })
    expect(restored.open(first, 1)).toBe(true)
    await expect(restored.load(restored.metadata?.revision ?? 0)).resolves.toMatchObject({
      content: "<h1>First</h1>",
    })
    expect(restored.open({ ...first, name: "unregistered.html" })).toBe(false)
    restored.clear()
    expect(restored.open(first)).toBe(false)
  })

  it("deduplicates private copies and never puts preview content in tool output", async () => {
    const context = await setup()
    const path = join(context.cwd, "notes.md")
    await writeFile(path, "# PRIVATE_DOCUMENT_CONTENT")
    const first = await publish(path, context)
    expect(await publish(path, context, first.artifactId)).toEqual(first)
    const result = await executeToolCall({ name: "publish_artifact", input: { path } }, context)
    expect(result.output).not.toContain("PRIVATE_DOCUMENT_CONTENT")
    expect(await readdir(context.artifactDirectory)).toEqual([first.sha256])
    if (process.platform !== "win32") {
      expect((await stat(context.artifactDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(context.artifactDirectory, first.sha256))).mode & 0o777).toBe(0o600)
    }
  })

  it("publishes supported native formats without flattening source bytes", async () => {
    const context = await setup()
    const fixtures = [
      { name: "page.html", bytes: Buffer.from("<h1>Page</h1>"), encoding: "utf8" },
      { name: "notes.txt", bytes: Buffer.from("Notes"), encoding: "utf8" },
      { name: "report.pdf", bytes: Buffer.from(minimalPdf("PDF")), encoding: "bytes" },
      { name: "brief.docx", bytes: Buffer.from(await minimalDocx("Word")), encoding: "html" },
    ]
    for (const fixture of fixtures) {
      const path = join(context.cwd, fixture.name)
      await writeFile(path, fixture.bytes)
      const reference = await publish(path, context)
      expect(await readFile(join(context.artifactDirectory, reference.sha256))).toEqual(
        fixture.bytes,
      )
      await expect(
        loadPublishedArtifact(reference, 1, context.artifactDirectory),
      ).resolves.toMatchObject({
        encoding: fixture.encoding,
        title: fixture.name,
      })
    }
  })

  it("rejects invalid, oversized, missing, and unsupported files without publishing", async () => {
    const context = await setup()
    const fixtures = [
      ["invalid.txt", Buffer.from([0xff])],
      ["fake.pdf", Buffer.from("not a pdf")],
      ["fake.docx", Buffer.from("not a docx")],
      ["code.js", Buffer.from("console.log('hi')")],
      ["large.md", Buffer.alloc(2_000_001, 65)],
    ] as const
    for (const [name, bytes] of fixtures) {
      await writeFile(join(context.cwd, name), bytes)
      await expect(
        executeToolCall({ name: "publish_artifact", input: { path: name } }, context),
      ).rejects.toThrow()
    }
    await truncate(join(context.cwd, "large.md"), MAX_RAW_DOCUMENT_BYTES + 1)
    await expect(
      executeToolCall({ name: "publish_artifact", input: { path: "large.md" } }, context),
    ).rejects.toThrow("too large")
    await mkdir(join(context.cwd, "folder.html"))
    await expect(
      executeToolCall({ name: "publish_artifact", input: { path: "folder.html" } }, context),
    ).rejects.toThrow("regular files")
    await expect(
      executeToolCall({ name: "publish_artifact", input: { path: "missing.html" } }, context),
    ).rejects.toThrow()
    await expect(readdir(context.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects external paths without authorization and changed symlink targets after approval", async () => {
    const context = await setup()
    const external = join(context.root, "external.md")
    const other = join(context.root, "other.md")
    await writeFile(external, "Approved content")
    await writeFile(other, "Unapproved content")
    await expect(
      executeToolCall({ name: "publish_artifact", input: { path: external } }, context),
    ).rejects.toThrow("requires approval")
    const alias = join(context.cwd, "alias.md")
    await symlink(external, alias)
    const decision = await createPermissionPolicy({ cwd: context.cwd, mode: "auto" }).evaluate({
      name: "publish_artifact",
      input: { path: alias },
    })
    expect(decision.effect).toBe("ask")
    expect(decision.artifactPath).toBe(await realpath(external))
    await rm(alias)
    await symlink(other, alias)
    await expect(
      executeToolCall(
        { name: "publish_artifact", input: { path: alias } },
        { ...context, authorizedArtifactPath: decision.artifactPath },
      ),
    ).rejects.toThrow("path changed")
    await expect(readdir(context.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("validates persisted references and reports missing or damaged saved copies", async () => {
    const context = await setup()
    await writeFile(join(context.cwd, "notes.md"), "Original")
    const reference = await publish("notes.md", context)
    for (const name of [
      "../notes.md",
      "nested/notes.md",
      "nested\\notes.md",
      "bad\0.md",
      "notes.js",
    ]) {
      expect(isPublishedArtifactReference({ ...reference, name })).toBe(false)
    }
    expect(isPublishedArtifactReference({ ...reference, sha256: "../../other" })).toBe(false)
    expect(isPublishedArtifactReference({ ...reference, kind: "pdf" })).toBe(false)
    const saved = join(context.artifactDirectory, reference.sha256)
    await writeFile(saved, "Corrupted")
    await expect(loadPublishedArtifact(reference, 1, context.artifactDirectory)).rejects.toThrow(
      "damaged",
    )
    await rm(saved)
    await expect(loadPublishedArtifact(reference, 1, context.artifactDirectory)).rejects.toThrow(
      "published copy is no longer available",
    )
    expect(await publish("notes.md", context, reference.artifactId)).toEqual(reference)
    await expect(
      loadPublishedArtifact(reference, 2, context.artifactDirectory),
    ).resolves.toMatchObject({
      content: "Original",
    })
  })
})
