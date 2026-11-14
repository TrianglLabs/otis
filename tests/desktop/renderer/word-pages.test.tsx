// @vitest-environment jsdom
// jsdom, not happy-dom: docx-preview reads a Word part's prefixed attributes by local name, which
// only jsdom reports for XML (happy-dom keeps the prefix, so no section type or break type reads).

import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { ArtifactMetadata, ArtifactPayload } from "../../../src/artifacts/types.js"
import { FileArtifact } from "../../../src/desktop/renderer/features/canvas/FileArtifact.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"
import { docxWithBody } from "../../inference/support/document-fixtures.js"
import { fakeApi, snapshotFixture } from "../support/desktop-api.js"

afterEach(cleanup)

const word: ArtifactMetadata = {
  id: "workspace:report.docx",
  revision: 1,
  source: "workspace",
  kind: "docx",
  title: "report.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  editable: false,
  path: "report.docx",
}

/** The pages docx-preview hands the frame, before the frame measures and splits them. */
async function pagesOf(body: string) {
  cleanup()
  const content = await docxWithBody(body)
  const api = fakeApi(snapshotFixture(), {
    getArtifact: vi.fn(async () => ({
      ok: true as const,
      payload: { ...word, encoding: "bytes", content } as ArtifactPayload,
    })),
  })
  render(
    <DesktopProvider value={{ api, store: new DesktopViewStore(api) }}>
      <FileArtifact runtime={1} artifact={word} />
    </DesktopProvider>,
  )
  await act(async () => {})
  const frame = await vi.waitFor(() => {
    const found = document.querySelector('iframe[title="report.docx"]')
    if (!found) throw new Error("The Word frame is not shown yet")
    return found as HTMLIFrameElement
  })
  const postMessage = vi.spyOn(frame.contentWindow as Window, "postMessage")
  fireEvent.load(frame)
  const message = postMessage.mock.calls
    .map(([sent]) => sent as { type: string; source?: string })
    .find((sent) => sent.type === "otis-webpage-source")
  return (message?.source ?? "").split('<section class="docx"').length - 1
}

const p = (text: string, before = "") => `<w:p>${before}<w:r><w:t>${text}</w:t></w:r></w:p>`
const sect = (type?: string) =>
  `<w:sectPr>${type ? `<w:type w:val="${type}"/>` : ""}<w:pgSz w:w="12240" w:h="15840"/></w:sectPr>`
const sectionEnd = `<w:p><w:pPr>${sect()}</w:pPr></w:p>`

it("ends no page at the page breaks Word saved from its own layout", async () => {
  const hint = "<w:r><w:lastRenderedPageBreak/></w:r>"
  expect(await pagesOf(p("One") + p("Two", hint) + sect())).toBe(1)
})

it("keeps a continuous section on the page and starts a page for any other", async () => {
  expect(await pagesOf(p("One") + sectionEnd + p("Two") + sect("continuous"))).toBe(1)
  expect(await pagesOf(p("One") + sectionEnd + p("Two") + sect("nextPage"))).toBe(2)
  // A section with no type starts a new page, as Word's default does.
  expect(await pagesOf(p("One") + sectionEnd + p("Two") + sect())).toBe(2)
})

it("still breaks the page where the author put a page break", async () => {
  const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
  expect(await pagesOf(p("One") + pageBreak + p("Two") + sect())).toBe(2)
})
