// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { DetachedWindowAPI } from "happy-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ArtifactMetadata, ArtifactPayload } from "../../../src/artifacts/types.js"
import { FileArtifact } from "../../../src/desktop/renderer/features/canvas/FileArtifact.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"
import { fakeApi, snapshotFixture } from "../support/desktop-api.js"

const happyDOM = (window as typeof window & { happyDOM: DetachedWindowAPI }).happyDOM
beforeEach(() => {
  happyDOM.settings.fetch.interceptor = {
    beforeAsyncRequest: async ({ request, window: frameWindow }) =>
      ["/canvas.html", "/webpage.html"].includes(new URL(request.url).pathname)
        ? new frameWindow.Response("<!doctype html><title>Frame</title>", {
            headers: { "content-type": "text/html" },
          })
        : undefined,
  }
})
afterEach(cleanup)

const markdown: ArtifactMetadata = {
  id: "workspace:notes.md",
  revision: 1,
  source: "workspace",
  kind: "markdown",
  title: "notes.md",
  mimeType: "text/markdown",
  editable: true,
  path: "notes.md",
}

async function show(artifact: ArtifactMetadata, payload: object) {
  const api = fakeApi(snapshotFixture(), {
    getArtifact: vi.fn(async () => ({
      ok: true as const,
      payload: { ...artifact, ...payload } as ArtifactPayload,
    })),
  })
  const runtime = { api, store: new DesktopViewStore(api) }
  const view = render(
    <DesktopProvider value={runtime}>
      <FileArtifact runtime={1} artifact={artifact} />
    </DesktopProvider>,
  )
  await act(async () => {})
  return { api, view }
}

it("finds text in a Markdown document from the keyboard, stepping and wrapping through matches", async () => {
  await show(markdown, { encoding: "utf8", content: "# Otis\n\nOtis keeps notes. otis again." })
  const section = screen.getByRole("region", { name: "notes.md" })
  expect(screen.queryByRole("textbox", { name: "Find in document" })).toBeNull()
  fireEvent.keyDown(section, { key: "f", ctrlKey: true })
  const input = await screen.findByRole("textbox", { name: "Find in document" })
  fireEvent.change(input, { target: { value: "otis" } })
  expect(screen.getByText("1 of 3")).toBeTruthy()
  fireEvent.keyDown(input, { key: "Enter" })
  expect(screen.getByText("2 of 3")).toBeTruthy()
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
  expect(screen.getByText("3 of 3")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Next match" }))
  expect(screen.getByText("1 of 3")).toBeTruthy()
  fireEvent.change(input, { target: { value: "nowhere" } })
  expect(screen.getByText("No matches")).toBeTruthy()
  fireEvent.keyDown(input, { key: "Escape" })
  expect(screen.queryByRole("textbox", { name: "Find in document" })).toBeNull()
})

it("zooms a document from the toolbar and shortcuts, within bounds, and resets it", async () => {
  await show(markdown, { encoding: "utf8", content: "Body" })
  const section = screen.getByRole("region", { name: "notes.md" })
  const zoomed = () => screen.getByText("Body").closest("article > div") as HTMLElement
  expect(zoomed().style.zoom).toBe("1")
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
  expect(zoomed().style.zoom).toBe("1.2")
  fireEvent.keyDown(section, { key: "-", ctrlKey: true })
  fireEvent.keyDown(section, { key: "-", ctrlKey: true })
  expect(Number(zoomed().style.zoom)).toBeCloseTo(1 / 1.2)
  for (let i = 0; i < 10; i += 1) fireEvent.keyDown(section, { key: "-", metaKey: true })
  expect(zoomed().style.zoom).toBe("0.5")
  expect(screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "Reset view" }))
  expect(zoomed().style.zoom).toBe("1")
  expect(screen.getByText("100%")).toBeTruthy()
})

it("drives find and zoom in a Word preview through the frame agent", async () => {
  const word: ArtifactMetadata = {
    ...markdown,
    id: "workspace:plan.docx",
    kind: "docx",
    title: "plan.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    path: "plan.docx",
  }
  await show(word, {
    encoding: "html",
    content: "<h1>Plan</h1>",
  })
  const frame = document.querySelector('iframe[title="plan.docx"]') as HTMLIFrameElement
  const frameWindow = frame.contentWindow as Window
  const postMessage = vi.spyOn(frameWindow, "postMessage")
  const fromFrame = (data: object) =>
    act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data, source: frameWindow }))
    })
  // Nothing reaches the page before its agent is ready; then the current view is sent.
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
  expect(
    postMessage.mock.calls.some(([m]) => (m as { type: string }).type === "otis-frame-zoom"),
  ).toBe(false)
  await fromFrame({ type: "otis-frame-ready" })
  expect(postMessage).toHaveBeenCalledWith({ type: "otis-frame-zoom", zoom: 1.2 }, "*")
  expect(postMessage).toHaveBeenCalledWith({ type: "otis-frame-find", query: "", index: 0 }, "*")
  await fromFrame({ type: "otis-frame-key", key: "f" })
  const input = await screen.findByRole("textbox", { name: "Find in document" })
  fireEvent.change(input, { target: { value: "plan" } })
  expect(postMessage).toHaveBeenLastCalledWith(
    { type: "otis-frame-find", query: "plan", index: 0 },
    "*",
  )
  await fromFrame({ type: "otis-frame-matches", count: 2 })
  expect(screen.getByText("1 of 2")).toBeTruthy()
  fireEvent.keyDown(input, { key: "Enter" })
  expect(postMessage).toHaveBeenLastCalledWith(
    { type: "otis-frame-find", query: "plan", index: 1 },
    "*",
  )
  // A message from any other window is ignored.
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "otis-frame-matches", count: 9 },
        source: {} as Window,
      }),
    )
  })
  expect(screen.getByText("2 of 2")).toBeTruthy()
})
