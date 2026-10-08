// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/react"
import type { ReactNode, UIEvent } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TranscriptEntry } from "../../../src/app/transcript.js"
import type { DesktopApi } from "../../../src/desktop/contracts.js"
import { TranscriptList } from "../../../src/desktop/renderer/features/conversation/TranscriptList.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import type { DesktopViewStore } from "../../../src/desktop/renderer/state.js"

// Stand-in for Virtuoso with the pieces these tests exercise: the scroller ref the scroll hook
// binds to, the class it toggles, and the flattened rows in order.
const scrollToIndex = vi.hoisted(() => vi.fn())
vi.mock("react-virtuoso", async () => {
  const { forwardRef, useImperativeHandle } = await import("react")
  return {
    Virtuoso: forwardRef(function Virtuoso(
      {
        scrollerRef,
        className,
        data = [],
        itemContent,
        onScrollCapture,
      }: {
        scrollerRef?: (element: HTMLElement | Window | null) => void
        className?: string
        data?: { id?: number; kind?: string }[]
        itemContent?: (index: number, item: unknown) => ReactNode
        onScrollCapture?: (event: UIEvent<HTMLElement>) => void
      },
      ref,
    ) {
      useImperativeHandle(ref, () => ({ scrollToIndex }))
      return (
        <div className={className} ref={scrollerRef} onScrollCapture={onScrollCapture}>
          {data.map((item, index) => (
            <div key={`${item.kind ?? "item"}-${item.id ?? index}`}>
              {itemContent?.(index, item)}
            </div>
          ))}
        </div>
      )
    }),
  }
})

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

function renderList(
  entries: TranscriptEntry[],
  thinkingVisible = false,
  busy = false,
  rail = false,
) {
  const view = render(
    <DesktopProvider value={runtime}>
      <TranscriptList entries={entries} thinkingVisible={thinkingVisible} busy={busy} rail={rail} />
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

describe("turn rail", () => {
  const you = (text: string, extra: Partial<TranscriptEntry> = {}) =>
    message({ speaker: "You", text, ...extra })
  const threeTurns = () => [
    you("Fix the flaky lock test\n📎 ci-run.png", { messageText: "Fix the flaky lock test" }),
    message({ text: "Looking." }),
    tool(),
    you("", { messageText: "", images: ["screen.png"] }),
    message({ text: "Done." }),
    you("Now the docs"),
  ]
  // The list fits the window until the scroller says otherwise.
  const scrollTo = (scroller: HTMLElement, top: number) => {
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true })
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true })
    scroller.scrollTop = top
    fireEvent.scroll(scroller)
  }
  it("marks each user turn once the session scrolls, names it, and lights the clicked one", () => {
    scrollToIndex.mockClear()
    const { container } = renderList(threeTurns(), false, false, true)
    expect(container.querySelector(".turnRail")).toBeNull()
    const scroller = container.querySelector(".transcriptScroll") as HTMLElement
    scrollTo(scroller, 400)
    const ticks = container.querySelectorAll<HTMLButtonElement>(".turnRail-tick")
    expect([...ticks].map((tick) => tick.getAttribute("aria-label"))).toEqual([
      "Fix the flaky lock test",
      "screen.png",
      "Now the docs",
    ])
    fireEvent.click(ticks[1] as HTMLButtonElement)
    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 3, align: "start" }),
    )
    expect(ticks[1]?.getAttribute("aria-current")).toBe("step")
    // The clicked turn stays lit through the scroll it caused, whatever lands at the top.
    scrollTo(scroller, 1400)
    expect(ticks[1]?.getAttribute("aria-current")).toBe("step")
    // The reader's own wheel hands the light back to the view, here resting at the tail.
    fireEvent.wheel(scroller, { deltaY: 40 })
    scrollTo(scroller, 1400)
    expect(ticks[2]?.getAttribute("aria-current")).toBe("step")
  })
  it("lights the turn whose content crosses the top edge, and the first before any turn", () => {
    const { container } = renderList(threeTurns(), false, false, true)
    const scroller = container.querySelector(".transcriptScroll") as HTMLElement
    // Rows 0..2 sit above the top edge, row 3 (the second turn's start) crosses it.
    const rows = container.querySelectorAll<HTMLElement>(".transcriptEntry")
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => ({ bottom: index < 3 ? -10 : 40 + index }) as DOMRect
    })
    scrollTo(scroller, 400)
    const ticks = container.querySelectorAll<HTMLButtonElement>(".turnRail-tick")
    expect(ticks[1]?.getAttribute("aria-current")).toBe("step")
    // Only an assistant row before the first turn is across the edge: the first turn stands.
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => ({ bottom: index === 1 ? 40 : -10 }) as DOMRect
    })
    scrollTo(scroller, 300)
    expect(ticks[0]?.getAttribute("aria-current")).toBe("step")
    // A wheel on a tick itself does not hand the light back to the view.
    fireEvent.click(ticks[2] as HTMLButtonElement)
    fireEvent.wheel(ticks[2] as HTMLButtonElement, { deltaY: 40 })
    scrollTo(scroller, 300)
    expect(ticks[2]?.getAttribute("aria-current")).toBe("step")
  })
  it("has no rail for two turns, for a session that fits its window, or in a split", () => {
    const short = renderList([you("One"), message({ text: "A" }), you("Two")], false, false, true)
    scrollTo(short.container.querySelector(".transcriptScroll") as HTMLElement, 400)
    expect(short.container.querySelector(".turnRail")).toBeNull()
    cleanup()
    const fits = renderList(threeTurns(), false, false, true)
    expect(fits.container.querySelector(".turnRail")).toBeNull()
    // Scrolling content brings the rail; content that fits again, with the view at both edges at
    // once, takes it away.
    const scroller = fits.container.querySelector(".transcriptScroll") as HTMLElement
    scrollTo(scroller, 400)
    expect(fits.container.querySelector(".turnRail")).not.toBeNull()
    Object.defineProperty(scroller, "scrollHeight", { value: 600, configurable: true })
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(fits.container.querySelector(".turnRail")).toBeNull()
    cleanup()
    const split = renderList(threeTurns())
    scrollTo(split.container.querySelector(".transcriptScroll") as HTMLElement, 400)
    expect(split.container.querySelector(".turnRail")).toBeNull()
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
    expect(view.container.querySelector(".jumpToLatest")).toBeNull()
    fireEvent.click(header())
    expect(header().getAttribute("aria-expanded")).toBe("true")
    expect(rows(view.container)).toEqual([`run:${a.id}`, String(a.id), String(b.id)])
    // Opening a run stops the tail from pulling the view down; Latest offers the way back.
    expect(view.container.querySelector(".jumpToLatest")).not.toBeNull()
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

  it("counts occurrences in the text rows show, scrolls to the current one, and marks its row", () => {
    const onFindCount = vi.fn()
    const entries = [
      message({ speaker: "You", text: "Does the Lock lock?" }),
      tool({ text: "Reading files: lock.ts", activityKind: "file_read" }),
      tool({ text: "Searching files: drain", activityKind: "file_search" }),
      reasoning({ text: "The lock is per workspace.", streaming: false }),
      message({ text: "The lock drains on switch." }),
    ]
    const list = (find: { query: string; index: number } | undefined) => (
      <DesktopProvider value={runtime}>
        <TranscriptList
          entries={entries}
          thinkingVisible={false}
          find={find}
          onFindCount={onFindCount}
        />
      </DesktopProvider>
    )
    scrollToIndex.mockClear()
    const view = render(list(undefined))
    expect(view.container.querySelector(".jumpToLatest")).toBeNull()
    view.rerender(list({ query: "lock", index: 0 }))
    // Case-insensitive, two in the first row; the folded run and thought hide their text.
    expect(onFindCount).toHaveBeenLastCalledWith(3)
    const found = () => view.container.querySelector<HTMLElement>('[aria-current="true"]')
    expect(found()?.dataset.entryId).toBe(String(entries[0].id))
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 0, align: "center" })
    // Following the tail stops once a match is in view.
    expect(view.container.querySelector(".jumpToLatest")).toBeTruthy()
    view.rerender(list({ query: "lock", index: 1 }))
    expect(found()?.dataset.entryId).toBe(String(entries[0].id))
    expect(scrollToIndex).toHaveBeenCalledTimes(1)
    view.rerender(list({ query: "lock", index: 2 }))
    expect(found()?.dataset.entryId).toBe(String(entries[4].id))
    // The hidden thought is not a row: the last message is the third row.
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 2, align: "center" })
    // Opening the run puts its entries on screen and into the search.
    fireEvent.click(
      view.container.querySelector(`[data-run-id="${entries[1].id}"] button`) as HTMLElement,
    )
    expect(onFindCount).toHaveBeenLastCalledWith(4)
    view.rerender(list({ query: "lock", index: 2 }))
    expect(found()?.dataset.entryId).toBe(String(entries[1].id))
    view.rerender(list(undefined))
    expect(onFindCount).toHaveBeenLastCalledWith(0)
    expect(found()).toBeNull()
  })
})
