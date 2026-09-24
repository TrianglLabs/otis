// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { ArtifactMetadata, PublishedArtifactReference } from "../../../src/artifacts/types.js"
import { createDemoRuntime } from "../../../src/desktop/renderer/demo/demo-runtime.js"
import { FileArtifact } from "../../../src/desktop/renderer/features/canvas/FileArtifact.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"

/** The Canvas tab in view: the one that last took it. */
function shown(snapshot: { artifacts: { artifact: ArtifactMetadata; activated: number }[] }) {
  return snapshot.artifacts.reduce<(typeof snapshot.artifacts)[number] | undefined>(
    (best, tab) => (!best || tab.activated > best.activated ? tab : best),
    undefined,
  )?.artifact
}

afterEach(cleanup)

it("saves the displayed revision, reports errors, and resets the action when the revision changes", async () => {
  const api = createDemoRuntime()
  const runtime = { api, store: new DesktopViewStore(api) }
  const artifact = shown(await api.getSnapshot())
  if (!artifact) throw new Error("Expected demo artifact")
  const save = vi
    .spyOn(api, "saveArtifact")
    .mockResolvedValue({ ok: false, reason: "The destination is read-only." })
  const view = render(
    <DesktopProvider value={runtime}>
      <FileArtifact runtime={1} artifact={artifact} />
    </DesktopProvider>,
  )
  await act(async () => {})
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save a copy" })))
  expect(save).toHaveBeenCalledExactlyOnceWith(1, artifact.id, artifact.revision)
  expect(screen.getByRole("alert").textContent).toBe("The destination is read-only.")
  const next = { ...artifact, revision: artifact.revision + 1 }
  vi.spyOn(api, "getArtifact").mockResolvedValue({
    ok: true,
    payload: { ...next, kind: "docx", encoding: "html", content: "<p>Another revision</p>" },
  })
  view.rerender(
    <DesktopProvider value={runtime}>
      <FileArtifact runtime={1} artifact={next} />
    </DesktopProvider>,
  )
  await act(async () => {})
  expect(screen.queryByRole("alert")).toBeNull()
  save.mockResolvedValue({ ok: true })
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save a copy" })))
  expect(save).toHaveBeenLastCalledWith(1, next.id, next.revision)
})

it("hides the selector for a single saved version and shows it when another version arrives", async () => {
  const api = createDemoRuntime()
  const runtime = { api, store: new DesktopViewStore(api) }
  const snapshot = await api.getSnapshot()
  const saved = shown(snapshot)
  if (!saved?.publication) throw new Error("Expected a published demo artifact")
  const artifact: ArtifactMetadata = {
    ...saved,
    publication: {
      ...saved.publication,
      reference: { ...saved.publication.reference, version: 1 },
      versions: [1],
    },
  }
  const view = render(
    <DesktopProvider value={runtime}>
      <FileArtifact runtime={1} artifact={artifact} />
    </DesktopProvider>,
  )
  await act(async () => {})
  expect(screen.queryByRole("combobox", { name: "Artifact versions" })).toBeNull()
  expect(screen.getByText("Saved version 1")).toBeTruthy()

  view.rerender(
    <DesktopProvider value={runtime}>
      <FileArtifact runtime={1} artifact={saved} />
    </DesktopProvider>,
  )
  await act(async () => {})
  const versions = screen.getByRole("combobox", { name: "Artifact versions" }) as HTMLSelectElement
  expect(versions.value).toBe("latest")
  expect(versions.options.length).toBe(4)
})

it("shows saved revisions separately from working files and lets users pin a version or follow latest", async () => {
  const api = createDemoRuntime()
  const runtime = { api, store: new DesktopViewStore(api) }
  const reference: PublishedArtifactReference = {
    source: "published",
    artifactId: "12345678-1234-1234-1234-123456789abc",
    version: 2,
    name: "notes.md",
    sourcePath: "/workspace/notes.md",
    kind: "markdown",
    sha256: "a".repeat(64),
  }
  const artifact: ArtifactMetadata = {
    id: `published:${reference.artifactId}`,
    source: "published",
    kind: "markdown",
    title: "notes.md",
    revision: 1,
    mimeType: "text/markdown",
    editable: false,
    publication: { reference, versions: [1, 2], followingLatest: true },
  }
  vi.spyOn(api, "getArtifact").mockResolvedValue({
    ok: true,
    payload: { ...artifact, kind: "markdown", encoding: "utf8", content: "# Saved document" },
  })
  const open = vi.spyOn(api, "openArtifact").mockResolvedValue({ ok: true })
  const view = render(
    <DesktopProvider value={runtime}>
      <FileArtifact runtime={1} artifact={artifact} />
    </DesktopProvider>,
  )
  await act(async () => {})
  expect(screen.getByRole("heading", { name: "Saved document" })).toBeTruthy()
  const versions = screen.getByRole("combobox", { name: "Artifact versions" }) as HTMLSelectElement
  expect(versions.value).toBe("latest")
  await act(async () => fireEvent.change(versions, { target: { value: "1" } }))
  expect(open).toHaveBeenLastCalledWith(reference, 1, 1)
  const pinned = {
    ...artifact,
    revision: 2,
    publication: {
      reference: { ...reference, version: 1 },
      versions: [1, 2],
      followingLatest: false,
    },
  }
  view.rerender(
    <DesktopProvider value={runtime}>
      <FileArtifact runtime={1} artifact={pinned} />
    </DesktopProvider>,
  )
  await act(async () => {})
  expect(versions.value).toBe("1")
  await act(async () => fireEvent.change(versions, { target: { value: "latest" } }))
  expect(open).toHaveBeenLastCalledWith(pinned.publication.reference, undefined, 1)
  open.mockResolvedValueOnce({ ok: false, reason: "Session changed" })
  await act(async () => fireEvent.change(versions, { target: { value: "2" } }))
  expect(screen.getByRole("alert").textContent).toBe("Session changed")
  view.rerender(
    <DesktopProvider value={runtime}>
      <FileArtifact
        runtime={1}
        artifact={{ ...artifact, source: "workspace", publication: undefined, revision: 3 }}
      />
    </DesktopProvider>,
  )
  await act(async () => {})
  expect(screen.queryByRole("combobox")).toBeNull()
  expect(screen.getByText("Working file")).toBeTruthy()
})

it("keeps the current preview while a revision loads, ignores stale results, and shows reasons verbatim", async () => {
  const api = createDemoRuntime()
  const runtime = { api, store: new DesktopViewStore(api) }
  const artifact: ArtifactMetadata = {
    id: "workspace:notes.md",
    revision: 1,
    source: "workspace",
    kind: "markdown",
    title: "notes.md",
    mimeType: "text/markdown",
    editable: true,
    path: "notes.md",
  }
  const pending = new Map<number, (result: Awaited<ReturnType<typeof api.getArtifact>>) => void>()
  vi.spyOn(api, "getArtifact").mockImplementation(
    (_runtime, _id, revision) =>
      new Promise((resolve) => {
        pending.set(revision, resolve)
      }),
  )
  const at = (revision: number, id = artifact.id) => (
    <DesktopProvider value={runtime}>
      <FileArtifact runtime={1} artifact={{ ...artifact, id, revision }} />
    </DesktopProvider>
  )
  const view = render(at(1))
  // Export reads original bytes, so it never waits for the preview.
  const save = screen.getByRole("button", { name: "Save a copy" }) as HTMLButtonElement
  expect(save.disabled).toBe(false)
  expect(screen.getByText("Loading preview…")).toBeTruthy()
  await act(async () =>
    pending.get(1)?.({
      ok: true,
      payload: { ...artifact, kind: "markdown", encoding: "utf8", content: "# First" },
    }),
  )
  expect(screen.getByRole("heading", { name: "First" })).toBeTruthy()

  view.rerender(at(2))
  await act(async () => {})
  expect(screen.getByRole("heading", { name: "First" })).toBeTruthy()
  expect(screen.queryByText("Loading preview…")).toBeNull()
  await act(async () => pending.get(2)?.({ ok: false, stale: true, reason: "stale" }))
  expect(screen.getByRole("heading", { name: "First" })).toBeTruthy()
  expect(screen.queryByText("stale")).toBeNull()

  view.rerender(at(3))
  await act(async () =>
    pending.get(3)?.({ ok: false, reason: "The file changed while being read." }),
  )
  expect(screen.getByText("The file changed while being read.")).toBeTruthy()
  expect(screen.queryByRole("heading", { name: "First" })).toBeNull()
  expect((screen.getByRole("button", { name: "Save a copy" }) as HTMLButtonElement).disabled).toBe(
    false,
  )

  view.rerender(at(4))
  await act(async () =>
    pending.get(4)?.({
      ok: true,
      payload: { ...artifact, kind: "markdown", encoding: "utf8", content: "# Fourth" },
    }),
  )
  expect(screen.getByRole("heading", { name: "Fourth" })).toBeTruthy()
  view.rerender(at(5, "workspace:other.md"))
  await act(async () => {})
  expect(screen.queryByRole("heading", { name: "Fourth" })).toBeNull()
  expect(screen.getByText("Loading preview…")).toBeTruthy()
})
