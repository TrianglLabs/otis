// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PdfPreview } from "../../../src/desktop/renderer/features/canvas/PdfPreview.js"

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  createWorker: vi.fn(),
  destroyWorker: vi.fn(),
  terminate: vi.fn(),
  constructWorker: vi.fn(),
}))
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: mocks.getDocument,
  PDFWorker: { create: mocks.createWorker },
}))
vi.mock("pdfjs-dist/legacy/build/pdf.worker.mjs?worker", () => ({
  default: class {
    constructor() {
      mocks.constructWorker()
    }
    terminate = mocks.terminate
  },
}))
// Layout and virtualized scrolling are tested in the real Electron fixture.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    itemContent,
    scrollerRef,
    totalCount,
  }: {
    itemContent: (index: number) => React.ReactNode
    scrollerRef: (element: HTMLDivElement | null) => void
    totalCount: number
  }) => <div ref={scrollerRef}>{totalCount > 0 ? itemContent(0) : null}</div>,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createWorker.mockReturnValue({ destroy: mocks.destroyWorker })
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(560)
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("PDF preview lifecycle", () => {
  it("reports page rendering failures instead of silently leaving a blank canvas", async () => {
    const page = fakePage()
    page.render.mockImplementation(() => ({
      promise: Promise.reject(new Error("Page rendering failed")),
      cancel: vi.fn(),
    }))
    const loading = {
      promise: Promise.resolve({ numPages: 1, getPage: vi.fn(async () => page) }),
      destroy: vi.fn(async () => {}),
    }
    mocks.getDocument.mockReturnValue(loading)
    render(<PdfPreview data={pdfBytes()} />)
    expect((await screen.findByRole("alert")).textContent).toBe("Page rendering failed")
    expect(page.cleanup).toHaveBeenCalled()
  })

  it("cancels rendering and waits for transport disposal before terminating its worker", async () => {
    const rendering = deferred()
    const disposal = deferred()
    const page = fakePage()
    const cancel = vi.fn(() => rendering.reject(new Error("Rendering cancelled")))
    page.render.mockReturnValue({ promise: rendering.promise, cancel })
    const loading = {
      promise: Promise.resolve({ numPages: 1, getPage: vi.fn(async () => page) }),
      destroy: vi.fn(() => disposal.promise),
    }
    mocks.getDocument.mockReturnValue(loading)
    const view = render(<PdfPreview data={pdfBytes()} />)
    const canvas = (await screen.findByLabelText("Page 1")) as HTMLCanvasElement
    await waitFor(() => expect(page.render).toHaveBeenCalled())
    view.unmount()
    expect(cancel).toHaveBeenCalledOnce()
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(loading.destroy).toHaveBeenCalledOnce()
    expect(mocks.terminate).not.toHaveBeenCalled()
    await act(async () => disposal.resolve(undefined))
    expect(mocks.destroyWorker).toHaveBeenCalledOnce()
    expect(mocks.terminate).toHaveBeenCalledOnce()
  })

  it("does not create a worker if the preview unmounts during the library import", async () => {
    const view = render(<PdfPreview data={pdfBytes()} />)
    view.unmount()
    await act(async () => {})
    expect(mocks.constructWorker).not.toHaveBeenCalled()
    expect(mocks.getDocument).not.toHaveBeenCalled()
  })

  it("replaces the document in place, releasing the old transport only after the new one loads", async () => {
    const first = fakePage()
    const second = fakePage()
    const firstLoading = {
      promise: Promise.resolve({ numPages: 1, getPage: vi.fn(async () => first) }),
      destroy: vi.fn(async () => {}),
    }
    const secondLoaded = deferred<{ numPages: number; getPage: () => Promise<unknown> }>()
    const secondLoading = { promise: secondLoaded.promise, destroy: vi.fn(async () => {}) }
    mocks.getDocument.mockReturnValueOnce(firstLoading).mockReturnValueOnce(secondLoading)
    const view = render(<PdfPreview data={pdfBytes("one")} />)
    await screen.findByLabelText("Page 1")
    await waitFor(() => expect(first.render).toHaveBeenCalled())
    view.rerender(<PdfPreview data={pdfBytes("two")} />)
    await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(2))
    // The bytes are copied so a transferred buffer never empties the retained payload.
    const handed = mocks.getDocument.mock.calls[1]?.[0] as { data: Uint8Array }
    expect(handed.data).toEqual(pdfBytes("two"))
    expect(screen.getByLabelText("Page 1")).toBeTruthy()
    expect(screen.queryByText("Loading preview…")).toBeNull()
    expect(firstLoading.destroy).not.toHaveBeenCalled()
    await act(async () => secondLoaded.resolve({ numPages: 2, getPage: vi.fn(async () => second) }))
    expect(firstLoading.destroy).toHaveBeenCalledOnce()
    await waitFor(() => expect(second.render).toHaveBeenCalled())
  })

  it("re-renders pages only once the width has settled, scaling them meanwhile", async () => {
    const observers: (() => void)[] = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observers.push(callback)
        }
        observe() {}
        disconnect() {}
      },
    )
    let clientWidth = 560
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => clientWidth)
    const page = fakePage()
    mocks.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1, getPage: vi.fn(async () => page) }),
      destroy: vi.fn(async () => {}),
    })
    render(<PdfPreview data={pdfBytes()} />)
    const canvas = (await screen.findByLabelText("Page 1")) as HTMLCanvasElement
    await waitFor(() => expect(page.render).toHaveBeenCalledOnce())
    expect(canvas.style.width).toBe("528px")
    clientWidth = 400
    act(() => {
      for (const notify of observers) notify()
    })
    expect(canvas.style.width).toBe("368px")
    clientWidth = 420
    act(() => {
      for (const notify of observers) notify()
    })
    expect(canvas.style.width).toBe("388px")
    expect(page.render).toHaveBeenCalledOnce()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180))
    })
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(2))
    expect(page.getViewport).toHaveBeenLastCalledWith({ scale: 388 / 612 })
  })

  it("limits bitmap memory for oversized pages", async () => {
    const page = fakePage(100_000)
    mocks.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1, getPage: vi.fn(async () => page) }),
      destroy: vi.fn(async () => {}),
    })
    render(<PdfPreview data={pdfBytes()} />)
    const canvas = (await screen.findByLabelText("Page 1")) as HTMLCanvasElement
    await waitFor(() => expect(page.render).toHaveBeenCalled())
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(8_000_000)
    expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(16_384)
  })
})

function pdfBytes(text = "document") {
  return new TextEncoder().encode(text)
}

function fakePage(height = 792) {
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: height * scale,
    })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    cleanup: vi.fn(),
  }
}

function deferred<T = void>() {
  let resolve = (_value: T) => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
