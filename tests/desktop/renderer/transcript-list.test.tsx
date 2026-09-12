// @vitest-environment happy-dom

import { cleanup, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TranscriptEntry } from "../../../src/app/transcript.js"
import { TranscriptList } from "../../../src/desktop/renderer/features/conversation/TranscriptList.js"

// Stand-in for Virtuoso with the pieces these tests exercise: the scroller ref the scroll hook binds to
// and the class it toggles.
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

const entry: TranscriptEntry = { id: 1, kind: "message", speaker: "You", text: "hello" }

afterEach(cleanup)

describe("TranscriptList", () => {
  it("keeps the scrollbar thumb steadily visible while a turn is busy, not only while scrolling", () => {
    const view = render(<TranscriptList entries={[entry]} thinkingVisible={false} busy={true} />)
    const scroller = view.container.querySelector(".transcriptScroll") as HTMLElement
    expect(scroller.classList.contains("scrolling")).toBe(true)

    // Idle again: the thumb falls back to the hover/scroll reveal.
    view.rerender(<TranscriptList entries={[entry]} thinkingVisible={false} busy={false} />)
    expect(scroller.classList.contains("scrolling")).toBe(false)
  })
})
