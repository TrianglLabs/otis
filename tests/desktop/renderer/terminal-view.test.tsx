// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"
import { fakeApi, snapshotFixture } from "../support/desktop-api.js"

const { FakeTerminal, terminals } = vi.hoisted(() => {
  const terminals: FakeTerminal[] = []
  class FakeTerminal {
    cols = 80
    rows = 24
    scrollback = 0
    viewportY = 0
    written: string[] = []
    typed: ((data: string) => void)[] = []
    scrolled: ((line: number) => void)[] = []
    scrolledTo: number[] = []
    keys: ((event: KeyboardEvent) => boolean) | undefined
    focused = 0
    disposed = false
    mousedowns = 0
    handleMouseDown = () => {
      this.mousedowns += 1
    }
    constructor(public readonly settings: { theme?: { background?: string } }) {
      terminals.push(this)
    }
    loadAddon() {}
    open(element: HTMLElement) {
      element.addEventListener("mousedown", this.handleMouseDown, { capture: true })
    }
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keys = handler
    }
    // Like Ghostty 0.4: replies to the written data are emitted before write returns, the done
    // callback waits for an animation frame, which a hidden window never gets, and an empty
    // write throws.
    write(data: string, _done?: () => void) {
      if (!data) throw new RangeError("offset is out of bounds")
      this.written.push(data)
      if (data.includes("\x1b[c")) for (const handler of this.typed) handler("\x1b[?62c")
    }
    onData(handler: (data: string) => void) {
      this.typed.push(handler)
      return { dispose() {} }
    }
    onScroll(handler: (line: number) => void) {
      this.scrolled.push(handler)
      return { dispose() {} }
    }
    getScrollbackLength() {
      return this.scrollback
    }
    getViewportY() {
      return this.viewportY
    }
    scrollToLine(line: number) {
      this.scrolledTo.push(line)
      this.viewportY = Math.max(0, Math.min(this.scrollback, line))
      for (const handler of this.scrolled) handler(this.viewportY)
    }
    showScrollbar() {
      throw new Error("Ghostty's own scrollbar would paint over the grid")
    }
    focus() {
      this.focused += 1
    }
    dispose() {
      this.disposed = true
    }
  }
  return { FakeTerminal, terminals }
})
vi.mock("ghostty-web", () => ({
  init: async () => {},
  Terminal: FakeTerminal,
  FitAddon: class {
    proposeDimensions() {
      return { cols: 80, rows: 24 }
    }
  },
}))
// Reports the element's size once, as a real observer does when observation starts.
vi.stubGlobal(
  "ResizeObserver",
  class {
    constructor(private readonly callback: () => void) {}
    observe() {
      queueMicrotask(this.callback)
    }
    disconnect() {}
  },
)

import { TerminalView } from "../../../src/desktop/renderer/features/terminal/TerminalView.js"

afterEach(() => {
  cleanup()
  terminals.length = 0
})

function mount(overrides: Parameters<typeof fakeApi>[1]) {
  const api = fakeApi(snapshotFixture(), overrides)
  const store = new DesktopViewStore(api)
  // happy-dom computes no custom properties; the tokens come from here instead.
  const tokens: Record<string, string> = { "--bg-rail": "#101010" }
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    () =>
      ({
        getPropertyValue: (name: string) => tokens[name] ?? "",
      }) as unknown as CSSStyleDeclaration,
  )
  const view = render(
    <DesktopProvider value={{ api, store }}>
      <TerminalView activated={1} />
    </DesktopProvider>,
  )
  return { api, store, view }
}

describe("TerminalView", () => {
  it("attaches to the shell at its grid size, replays, then relays typing and output", async () => {
    let output: ((data: string) => void) | undefined
    const { api, store, view } = mount({
      // The retained output ends in a device-attributes query the shell made earlier.
      openTerminal: vi.fn(async () => "old \x1b[c"),
      subscribeTerminal: vi.fn((listener) => {
        output = listener
        return () => {}
      }),
    })
    await store.start()
    await waitFor(() => expect(terminals[0]?.written).toEqual(["old \x1b[c"]))
    const [term] = terminals
    expect(api.openTerminal).toHaveBeenCalledOnce()
    expect(api.resizeTerminal).toHaveBeenCalledWith(80, 24)
    expect(term.settings.theme?.background).toBe("#101010")
    expect(term.focused).toBe(1)
    // The terminal's reply to the replayed query stays here: the shell had it the first time.
    expect(api.writeTerminal).not.toHaveBeenCalled()

    act(() => output?.("$ "))
    expect(term.written).toEqual(["old \x1b[c", "$ "])
    // Typing goes through without waiting for a frame the window may never paint.
    term.typed[0]?.("ls\r")
    expect(api.writeTerminal).toHaveBeenCalledWith("ls\r")
    expect(api.writeTerminal).toHaveBeenCalledOnce()

    // App shortcuts are the app's, so the shell leaves them to bubble; everything else is its.
    expect(term.keys?.({ metaKey: true, ctrlKey: false, key: "k" } as KeyboardEvent)).toBe(true)
    expect(term.keys?.({ metaKey: false, ctrlKey: true, key: "c" } as KeyboardEvent)).toBe(false)

    view.rerender(
      <DesktopProvider value={{ api, store }}>
        <TerminalView activated={2} />
      </DesktopProvider>,
    )
    expect(term.focused).toBe(2)

    view.unmount()
    expect(term.disposed).toBe(true)
  })

  it("relays typing to a shell that has not printed yet", async () => {
    const { api, store } = mount({ openTerminal: vi.fn(async () => "") })
    await store.start()
    await waitFor(() => expect(api.resizeTerminal).toHaveBeenCalledWith(80, 24))
    const [term] = terminals
    await waitFor(() => expect(term?.typed).toHaveLength(1))
    expect(term?.written).toEqual([])
    term?.typed[0]?.("ls\r")
    expect(api.writeTerminal).toHaveBeenCalledWith("ls\r")
  })

  it("draws the app's scrollbar in the gutter and keeps Ghostty's off the grid", async () => {
    let output: ((data: string) => void) | undefined
    const { store, view } = mount({
      openTerminal: vi.fn(async () => "$ "),
      subscribeTerminal: vi.fn((listener) => {
        output = listener
        return () => {}
      }),
    })
    await store.start()
    await waitFor(() => expect(terminals[0]?.written).toEqual(["$ "]))
    const [term] = terminals
    const host = view.container.querySelector(".terminal") as HTMLElement
    const track = host.querySelector(".terminal-scrollbar") as HTMLElement
    const thumb = host.querySelector(".terminal-scrollbarThumb") as HTMLElement
    // Ghostty's bar never shows, and a click on the grid's last column no longer scrolls.
    expect(() => term.showScrollbar()).not.toThrow()
    host.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    expect(term.mousedowns).toBe(0)
    // Nothing to scroll yet.
    expect(track.hidden).toBe(true)

    // happy-dom lays nothing out; the track is 200px tall and the thumb what the view sets.
    Object.defineProperty(track, "clientHeight", { value: 200 })
    Object.defineProperty(thumb, "offsetHeight", {
      get: () => Number.parseFloat(thumb.style.height),
    })
    thumb.getBoundingClientRect = () =>
      ({ top: Number.parseFloat(thumb.style.transform.slice("translateY(".length)) }) as DOMRect
    term.scrollback = 176
    act(() => output?.("more\n"))
    expect(track.hidden).toBe(false)
    // 24 of 200 lines shown: a 24px thumb, at the bottom while the view is there.
    expect(thumb.style.height).toBe("24px")
    expect(thumb.style.transform).toBe("translateY(176px)")

    // Scrolled to the top, the thumb follows and flashes.
    act(() => term.scrollToLine(176))
    expect(thumb.style.transform).toBe("translateY(0px)")
    expect(host.classList.contains("scrolling")).toBe(true)

    // A click on the track centres the thumb there: halfway down is halfway up the scrollback.
    track.dispatchEvent(new MouseEvent("pointerdown", { clientY: 100, bubbles: true }))
    expect(term.scrolledTo.at(-1)).toBe(88)
    // Dragging the thumb by 44px moves a quarter of the way.
    thumb.dispatchEvent(new MouseEvent("pointerdown", { clientY: 90, bubbles: true }))
    document.dispatchEvent(new MouseEvent("pointermove", { clientY: 134 }))
    expect(term.scrolledTo.at(-1)).toBe(44)
    document.dispatchEvent(new MouseEvent("pointerup"))
    document.dispatchEvent(new MouseEvent("pointermove", { clientY: 190 }))
    expect(term.scrolledTo.at(-1)).toBe(44)
  })

  it("relies on Ghostty members that ghostty-web 0.4 still has", async () => {
    const real = await vi.importActual<typeof import("ghostty-web")>("ghostty-web")
    expect(typeof real.Terminal.prototype.getScrollbackLength).toBe("function")
    expect(typeof real.Terminal.prototype.getViewportY).toBe("function")
    expect(typeof real.Terminal.prototype.scrollToLine).toBe("function")
    const prototype = real.Terminal.prototype as unknown as Record<string, unknown>
    expect(typeof prototype.showScrollbar).toBe("function")
    expect(real.Terminal.toString()).toContain("this.handleMouseDown = ")
  })
})
