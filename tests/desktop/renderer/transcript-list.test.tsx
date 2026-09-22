// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TranscriptEntry } from "../../../src/app/transcript.js"
import type { DesktopApi } from "../../../src/desktop/contracts.js"
import { TranscriptList } from "../../../src/desktop/renderer/features/conversation/TranscriptList.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import type { DesktopViewStore } from "../../../src/desktop/renderer/state.js"

// Stand-in for Virtuoso with the pieces these tests exercise: the scroller ref the scroll hook
// binds to, the class it toggles, and the flattened rows in order.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    scrollerRef,
    className,
    data = [],
    itemContent,
  }: {
    scrollerRef?: (element: HTMLElement | Window | null) => void
    className?: string
    data?: { id?: number; kind?: string }[]
    itemContent?: (index: number, item: unknown) => ReactNode
  }) => (
    <div className={className} ref={scrollerRef}>
      {data.map((item, index) => (
        <div key={`${item.kind ?? "item"}-${item.id ?? index}`}>{itemContent?.(index, item)}</div>
      ))}
    </div>
  ),
}))

let nextId = 1
const entry = (
  partial: Partial<TranscriptEntry> & Pick<TranscriptEntry, "kind">,
): TranscriptEntry => ({
  id: nextId++,
  speaker: "Tool",
  text: `entry ${nextId}`,
  ...partial,
})
const tool = (partial: Partial<TranscriptEntry> = {}) => entry({ kind: "tool", ...partial })
const message = (partial: Partial<TranscriptEntry> = {}) =>
  entry({ kind: "message", speaker: "Otis", ...partial })
const reasoning = (partial: Partial<TranscriptEntry> = {}) =>
  entry({ kind: "reasoning", speaker: "Otis", ...partial })

// Rows never reach the API in these tests; the store is only read through the list's own props.
const runtime = { api: {} as DesktopApi, store: {} as DesktopViewStore }

function renderList(entries: TranscriptEntry[], thinkingVisible = false, busy = false) {
  const view = render(
    <DesktopProvider value={runtime}>
      <TranscriptList entries={entries} thinkingVisible={thinkingVisible} busy={busy} />
    </DesktopProvider>,
  )
  return {
    ...view,
    rerender: (next: TranscriptEntry[], nextBusy = busy) =>
      view.rerender(
        <DesktopProvider value={runtime}>
          <TranscriptList entries={next} thinkingVisible={thinkingVisible} busy={nextBusy} />
        </DesktopProvider>,
      ),
  }
}

/** The transcript's rows in order: `run:<first id>` for a condensed run, `<id>` for an entry. */
function rows(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(".transcriptEntry"), (row) =>
    row.dataset.runId ? `run:${row.dataset.runId}` : row.dataset.entryId,
  )
}

afterEach(cleanup)

describe("TranscriptList", () => {
  it("keeps the scrollbar thumb steadily visible while a turn is busy, not only while scrolling", () => {
    const only = message({ speaker: "You", text: "hello" })
    const view = renderList([only], false, true)
    const scroller = view.container.querySelector(".transcriptScroll") as HTMLElement
    expect(scroller.classList.contains("scrolling")).toBe(true)

    // Idle again: the thumb falls back to the hover/scroll reveal.
    view.rerender([only], false)
    expect(scroller.classList.contains("scrolling")).toBe(false)
  })
})

describe("visible entries", () => {
  it.each([
    true,
    false,
  ])("omits empty assistant rows with thinking visible=%s", (thinkingVisible) => {
    const streaming = message({ text: "", streaming: true })
    const blank = message({ text: " \n\t" })
    const answer = message({ text: "Here is the answer." })
    const view = renderList([streaming, blank, answer], thinkingVisible)
    expect(rows(view.container)).toEqual([String(answer.id)])
    // The same streaming entry becomes visible as soon as it receives content.
    view.rerender([{ ...streaming, text: "Here is the answer." }])
    expect(rows(view.container)).toEqual([String(streaming.id)])
  })

  it("preserves artifact-only messages and empty live thinking", () => {
    const withArtifact = message({
      text: "",
      artifacts: [{ source: "workspace", path: "resume.docx", kind: "docx" }],
    })
    const liveThinking = reasoning({ text: "", streaming: true })
    const view = renderList([withArtifact, liveThinking], false)
    expect(rows(view.container)).toEqual([String(withArtifact.id), String(liveThinking.id)])
  })

  it("drops finished reasoning when thinking traces are hidden, keeping order and live traces", () => {
    const [a, live, b, done] = [
      message({ text: "a" }),
      reasoning({ streaming: true }),
      message({ text: "b" }),
      reasoning({ streaming: false }),
    ]
    expect(rows(renderList([a, live, b, done], false).container)).toEqual(
      [a, live, b].map((item) => String(item.id)),
    )
  })

  it("keeps every reasoning entry when thinking traces are shown", () => {
    const entries = [message({ text: "a" }), reasoning(), message({ text: "b" }), reasoning()]
    expect(rows(renderList(entries, true).container)).toEqual(entries.map((e) => String(e.id)))
  })
})

describe("tool runs", () => {
  it("collapses consecutive tool entries into one run keyed by the first entry", () => {
    const [a, b, c] = [tool(), tool(), tool()]
    expect(rows(renderList([a, b, c]).container)).toEqual([`run:${a.id}`])
  })

  it("keeps a single tool entry standalone", () => {
    const only = tool()
    expect(rows(renderList([only]).container)).toEqual([String(only.id)])
  })

  it("a tool entry with a diff stays standalone and breaks the run", () => {
    const [a, b] = [tool(), tool()]
    const edit = tool({ diff: "@@ -1 +1 @@\n-old\n+new" })
    const [c, d] = [tool(), tool()]
    expect(rows(renderList([a, b, edit, c, d]).container)).toEqual([
      `run:${a.id}`,
      String(edit.id),
      `run:${c.id}`,
    ])
  })

  it("keeps document artifacts standalone instead of hiding them in an activity run", () => {
    const [before, after] = [tool(), tool()]
    const artifact = tool({ artifact: { source: "workspace", path: "brief.pdf", kind: "pdf" } })
    expect(rows(renderList([before, artifact, after]).container)).toEqual(
      [before, artifact, after].map((item) => String(item.id)),
    )
  })

  it("folds pending and superseded artifact revisions into activity until the final card is ready", () => {
    const artifact = { source: "workspace" as const, path: "brief.pdf", kind: "pdf" as const }
    const pending = tool({ artifact, artifactDisplay: "pending" })
    const superseded = tool({ artifact, artifactDisplay: "superseded" })
    const ready = tool({ artifact, artifactDisplay: "ready" })
    expect(rows(renderList([pending, superseded]).container)).toEqual([`run:${pending.id}`])
    expect(rows(renderList([pending, ready]).container)).toEqual([
      String(pending.id),
      String(ready.id),
    ])
  })

  it("messages break runs", () => {
    const [a, b] = [tool(), tool()]
    const text = message({ text: "between" })
    expect(rows(renderList([a, text, b]).container)).toEqual(
      [a, text, b].map((item) => String(item.id)),
    )
  })

  it("keeps run identity stable as new activity appends", () => {
    const [a, b] = [tool(), tool()]
    const view = renderList([a, b])
    expect(rows(view.container)).toEqual([`run:${a.id}`])
    view.rerender([a, b, tool()])
    expect(rows(view.container)).toEqual([`run:${a.id}`])
  })

  it("expands a run into ordinary rows after its header, marked as in-run, and collapses it again", () => {
    const [a, b] = [tool(), tool()]
    const view = renderList([a, b])
    const header = () => view.container.querySelector(".toolRun-header") as HTMLButtonElement
    expect(header().getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(header())
    expect(header().getAttribute("aria-expanded")).toBe("true")
    expect(rows(view.container)).toEqual([`run:${a.id}`, String(a.id), String(b.id)])
    const inRun = view.container.querySelectorAll(".transcriptEntry-inRun")
    expect(Array.from(inRun, (row) => (row as HTMLElement).dataset.entryId)).toEqual(
      [a, b].map((item) => String(item.id)),
    )
    fireEvent.click(header())
    expect(rows(view.container)).toEqual([`run:${a.id}`])
  })

  it("flattens only the expanded run when several exist", () => {
    const [a, b, c, d] = [tool(), tool(), tool(), tool()]
    const divider = message({ text: "divider" })
    const view = renderList([a, b, divider, c, d])
    const headers = view.container.querySelectorAll(".toolRun-header")
    expect(headers).toHaveLength(2)
    fireEvent.click(headers[1] as HTMLButtonElement)
    expect(rows(view.container)).toEqual([
      `run:${a.id}`,
      String(divider.id),
      `run:${c.id}`,
      String(c.id),
      String(d.id),
    ])
    expect(view.container.querySelectorAll(".transcriptEntry-inRun")).toHaveLength(2)
  })
})
