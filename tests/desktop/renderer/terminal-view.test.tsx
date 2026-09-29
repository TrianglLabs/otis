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
    written: string[] = []
    typed: ((data: string) => void)[] = []
    keys: ((event: KeyboardEvent) => boolean) | undefined
    focused = 0
    disposed = false
    constructor(public readonly settings: { theme?: { background?: string } }) {
      terminals.push(this)
    }
    loadAddon() {}
    open() {}
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keys = handler
    }
    write(data: string, done?: () => void) {
      this.written.push(data)
      done?.()
    }
    onData(handler: (data: string) => void) {
      this.typed.push(handler)
      return { dispose() {} }
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

describe("TerminalView", () => {
  it("attaches to the shell at its grid size, replays, then relays typing and output", async () => {
    let output: ((data: string) => void) | undefined
    const api = fakeApi(snapshotFixture(), {
      openTerminal: vi.fn(async () => "old "),
      subscribeTerminal: vi.fn((listener) => {
        output = listener
        return () => {}
      }),
    })
    const store = new DesktopViewStore(api)
    await store.start()
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
    await waitFor(() => expect(terminals[0]?.written).toEqual(["old "]))
    const [term] = terminals
    expect(api.openTerminal).toHaveBeenCalledOnce()
    expect(api.resizeTerminal).toHaveBeenCalledWith(80, 24)
    expect(term.settings.theme?.background).toBe("#101010")
    expect(term.focused).toBe(1)

    act(() => output?.("$ "))
    expect(term.written).toEqual(["old ", "$ "])
    term.typed[0]?.("ls\r")
    expect(api.writeTerminal).toHaveBeenCalledWith("ls\r")

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
})
