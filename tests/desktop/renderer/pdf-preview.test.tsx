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
    render(<PdfPreview source={btoa("document")} />)
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
    const view = render(<PdfPreview source={btoa("document")} />)
    const canvas = (await screen.findByLabelText("Page 1")) as HTMLCanvasElement
    await waitFor(() => expect(page.render).toHaveBeenCalled())
    view.unmount()
    expect(cancel).toHaveBeenCalledOnce()
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(loading.destroy).toHaveBeenCalledOnce()
    expect(mocks.terminate).not.toHaveBeenCalled()
    await act(async () => disposal.resolve())
    expect(mocks.destroyWorker).toHaveBeenCalledOnce()
    expect(mocks.terminate).toHaveBeenCalledOnce()
  })

  it("does not create a worker if the preview unmounts during the library import", async () => {
    const view = render(<PdfPreview source={btoa("document")} />)
    view.unmount()
    await act(async () => {})
    expect(mocks.constructWorker).not.toHaveBeenCalled()
    expect(mocks.getDocument).not.toHaveBeenCalled()
  })

  it("limits bitmap memory for oversized pages", async () => {
    const page = fakePage(100_000)
    mocks.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1, getPage: vi.fn(async () => page) }),
      destroy: vi.fn(async () => {}),
    })
    render(<PdfPreview source={btoa("document")} />)
    const canvas = (await screen.findByLabelText("Page 1")) as HTMLCanvasElement
    await waitFor(() => expect(page.render).toHaveBeenCalled())
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(8_000_000)
    expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(16_384)
  })
})

function fakePage(height = 792) {
  return {
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: height * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    cleanup: vi.fn(),
  }
}

function deferred() {
  let resolve = () => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
