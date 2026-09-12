// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { useTranscriptScroll } from "../../../src/desktop/renderer/features/conversation/useTranscriptScroll.js"

type Scroll = ReturnType<typeof useTranscriptScroll>
type Holder = { scroll?: Scroll }

// The hook returns a fresh object each render; tests must re-read through the holder or they assert
// against a stale snapshot.
function scrollOf(holder: Holder): Scroll {
  if (!holder.scroll) throw new Error("probe mounted without exposing its scroll hook")
  return holder.scroll
}

// The hook's consumer in the app is Virtuoso's scroller: a plain div wired to the same handlers stands in
// for it, so the events below travel the real capture path React delegates at the root.
function Probe({ holder }: { holder: Holder }) {
  const scroll = useTranscriptScroll()
  holder.scroll = scroll
  return (
    <section
      aria-label="Transcript"
      ref={scroll.scrollerRef}
      onScrollCapture={scroll.onScrollCapture}
      onWheelCapture={scroll.onWheelCapture}
      onKeyDown={scroll.onKeyDown}
      onPointerDownCapture={scroll.onPointerDownCapture}
      onTouchStartCapture={scroll.onTouchStartCapture}
      onTouchMoveCapture={scroll.onTouchMoveCapture}
      data-testid="scroller"
    />
  )
}

// Happy-dom has no layout: give the scroller fixed metrics so follow math runs on real numbers. The
// setter clamps like a browser scroller, so scrollTop assignments land on the true bottom.
function stubMetrics(scroller: HTMLElement, top: number, height: number, viewport: number) {
  let scrollTop = top
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, height - viewport))
    },
  })
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => height })
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => viewport })
}

function mount(top: number, height: number, viewport: number): { holder: Holder; scroller: HTMLElement } {
  const holder: Holder = {}
  render(<Probe holder={holder} />)
  const scroller = screen.getByTestId("scroller")
  stubMetrics(scroller, top, height, viewport)
  return { holder, scroller }
}

const nextFrame = () => act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve())))

afterEach(cleanup)

describe("useTranscriptScroll", () => {
  it("jumps to the new bottom as streamed content grows the list", async () => {
    const { holder, scroller } = mount(0, 1000, 200)

    act(() => {
      scrollOf(holder).totalListHeightChanged(1000)
    })
    await nextFrame()
    expect(scroller.scrollTop).toBe(800)
  })

  it("does not yank the reader back to the tail when they scrolled up before any pin ran", async () => {
    // User input can arrive before the first layout-triggered pin.
    const { holder, scroller } = mount(800, 1000, 200)

    act(() => {
      fireEvent.wheel(scroller, { deltaY: -300 })
      scroller.scrollTop = 500
      fireEvent.scroll(scroller)
    })
    expect(scrollOf(holder).atBottom).toBe(false)

    act(() => {
      scrollOf(holder).totalListHeightChanged(1000)
    })
    await nextFrame()
    expect(scroller.scrollTop).toBe(500)
  })

  it.each(["keyboard", "scrollbar"])("pauses following for upward %s scrolling", async (input) => {
    const { holder, scroller } = mount(800, 1000, 200)
    if (input === "keyboard") fireEvent.keyDown(scroller, { key: "PageUp" })
    else fireEvent.pointerDown(scroller, { button: 0 })
    scroller.scrollTop = 400
    fireEvent.scroll(scroller)
    act(() => scrollOf(holder).totalListHeightChanged(1000))
    await nextFrame()
    expect(scroller.scrollTop).toBe(400)
    expect(scrollOf(holder).atBottom).toBe(false)
  })

  it("does not pause the transcript when a nested diff consumes the wheel input", async () => {
    const { holder, scroller } = mount(800, 1000, 200)
    const diff = document.createElement("div")
    diff.style.overflowY = "auto"
    diff.scrollTop = 50
    scroller.append(diff)
    fireEvent.wheel(diff, { deltaY: -20 })
    stubMetrics(scroller, 800, 1100, 200)
    act(() => scrollOf(holder).totalListHeightChanged(1100))
    await nextFrame()
    expect(scroller.scrollTop).toBe(900)
  })

  it("keeps following when layout rounds a fractional scroll position as new content arrives", async () => {
    const { holder, scroller } = mount(800.5, 1001, 200)
    fireEvent.scroll(scroller)

    // Chromium can clamp to a fractional bottom, then the virtual list rounds the position while the
    // next chunk grows the content. The half-pixel correction is not a reader scrolling upward.
    stubMetrics(scroller, 800, 1100, 200)
    fireEvent.scroll(scroller)
    expect(scrollOf(holder).atBottom).toBe(true)
    act(() => scrollOf(holder).totalListHeightChanged(1100))
    await nextFrame()
    expect(scroller.scrollTop).toBe(900)
  })

  it("flashes the scrollbar thumb while the scroller reports scrolling", () => {
    const { holder, scroller } = mount(0, 1000, 200)

    fireEvent.scroll(scroller)
    act(() => {
      scrollOf(holder).isScrolling(true)
    })
    expect(scrollOf(holder).scrolling).toBe(true)
    act(() => {
      scrollOf(holder).isScrolling(false)
    })
    expect(scrollOf(holder).scrolling).toBe(false)
  })
})
