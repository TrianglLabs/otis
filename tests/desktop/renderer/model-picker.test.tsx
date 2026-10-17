// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopApi } from "../../../src/desktop/contracts.js"
import { App } from "../../../src/desktop/renderer/App.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"
import type { ModelPickerItem } from "../../../src/inference/picker-catalog.js"
import { fakeApi, hostedConfigured, snapshotFixture } from "../support/desktop-api.js"

/** The model catalog overlay's search box: it narrows the rows and yields to Escape first. */

const SNAPSHOT = snapshotFixture({
  model: {
    id: "accounts/fireworks/models/kimi-k2p6",
    provider: "fireworks",
    displayName: "Kimi K2.6",
    supportsImageInput: false,
  },
  modelState: "ready",
  session: { id: "session-1", title: "Test session" },
  hostedConfigured: hostedConfigured("fireworks", "together"),
})

const CATALOG: ModelPickerItem[] = [
  { kind: "header", id: "header-local", displayName: "Local" },
  {
    kind: "model",
    provider: "local",
    id: "Qwen/Qwen3.8-27B",
    displayName: "Qwen3.8 27B",
    contextLength: 65_536,
    supportsImageInput: false,
    available: true,
    recommended: true,
    availabilityLabel: "Est. 64K · Q4_K_M · 17 GB",
    quant: "Q4_K_M",
    hasDownloadedPacking: true,
    cpuOffload: false,
    downloaded: true,
    active: false,
  },
  { kind: "header", id: "header-fireworks", displayName: "Fireworks AI" },
  {
    kind: "model",
    provider: "fireworks",
    id: "accounts/fireworks/models/kimi-k2p6",
    displayName: "Kimi K2.6",
    supportsImageInput: false,
    available: true,
    active: true,
  },
  { kind: "header", id: "header-together", displayName: "Together AI" },
  {
    kind: "model",
    provider: "together",
    id: "moonshotai/Kimi-K2.5",
    displayName: "Kimi K2.5",
    supportsImageInput: true,
    available: true,
    active: false,
  },
]

async function openPicker(overrides: Partial<DesktopApi> = {}) {
  const api = fakeApi(SNAPSHOT, { listModels: vi.fn(async () => CATALOG), ...overrides })
  const store = new DesktopViewStore(api)
  await store.start()
  render(
    <DesktopProvider value={{ api, store }}>
      <App />
    </DesktopProvider>,
  )
  fireEvent.click(screen.getByRole("button", { name: "Kimi K2.6" }))
  const dialog = await screen.findByRole("dialog", { name: "Select a model" })
  const list = dialog.querySelector(".modelPicker-list") as HTMLElement
  await within(list).findByText("Qwen3.8 27B")
  return {
    api,
    dialog,
    list,
    search: within(dialog).getByLabelText("Search models") as HTMLInputElement,
  }
}

afterEach(() => cleanup())

describe("model card", () => {
  it("pushes a local model's card over the list and selects from it", async () => {
    const { api, dialog, list } = await openPicker()
    fireEvent.click(within(list).getByRole("button", { name: "About Qwen3.8 27B" }))
    const card = within(dialog).getByRole("article", { name: "Qwen3.8 27B" })
    expect(within(card).getByRole("heading", { level: 2 }).textContent).toBe("Qwen3.8 27B")
    expect(within(card).getByText("Qwen")).toBeTruthy()
    expect(within(card).getByText(/Dense 27B with a vision encoder/)).toBeTruthy()
    expect(within(card).getByRole("heading", { name: "Best at" })).toBeTruthy()
    expect(within(card).getByText(/Image, document, and diagram understanding/)).toBeTruthy()
    expect(within(card).getByRole("heading", { name: "Worst at" })).toBeTruthy()
    expect(within(card).getByText(/about 23 GiB at a 64K context/)).toBeTruthy()
    // The figures strip: context, quality, input, and the thinking range with its default.
    expect(within(card).getByText("~64K").closest(".modelCard-stat")?.getAttribute("title")).toBe(
      "about 49,000 words it keeps in mind at once",
    )
    expect(within(card).getByText("4-bit").closest(".modelCard-stat")?.getAttribute("title")).toBe(
      "4-bit compressed · near full quality at a fraction of the size (Q4_K_M)",
    )
    expect(
      within(card).getByText("Off – Extra High").closest(".modelCard-stat")?.getAttribute("title"),
    ).toBe("Thinking: Off, Low, Medium, Extra High, default Extra High")
    expect(within(card).getByRole("link", { name: "Model card" }).getAttribute("href")).toBe(
      "https://huggingface.co/Qwen/Qwen3.8-27B",
    )
    // The catalog list is hidden behind the card, and the search box with it.
    expect(dialog.querySelector(".modelPicker-catalog")?.hasAttribute("hidden")).toBe(true)
    fireEvent.click(within(card).getByRole("button", { name: "Use this model" }))
    await act(async () => {})
    expect(api.selectModel).toHaveBeenCalledWith("local:Qwen/Qwen3.8-27B")
  })

  it("offers no card for hosted rows, and Escape returns to the list before clearing the query", async () => {
    const { dialog, list, search } = await openPicker()
    expect(within(list).queryByRole("button", { name: /About Kimi/ })).toBeNull()
    fireEvent.change(search, { target: { value: "qwen" } })
    fireEvent.click(within(list).getByRole("button", { name: "About Qwen3.8 27B" }))
    expect(within(dialog).getByRole("article", { name: "Qwen3.8 27B" })).toBeTruthy()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(within(dialog).queryByRole("article")).toBeNull()
    expect(search.value).toBe("qwen")
    expect(screen.getByRole("dialog", { name: "Select a model" })).toBeTruthy()
  })
})

describe("ModelPicker download progress", () => {
  const loading = (status: { label: string; percent?: number }) =>
    openPicker({
      getSnapshot: vi.fn(async () => ({
        ...SNAPSHOT,
        modelLoad: {
          modelId: "local:Qwen/Qwen3.8-27B",
          status: { kind: "progress" as const, ...status },
        },
      })),
    })

  it("rings the stop control with a measured download's progress", async () => {
    const { api, list } = await loading({ label: "Downloading 42%", percent: 42 })
    const row = within(list).getByText("Qwen3.8 27B").closest(".modelPicker-row") as HTMLElement
    const stop = within(row).getByRole("button", { name: "Cancel model load" })
    expect(stop.getAttribute("title")).toBe("Cancel model load · 42%")
    const arc = stop.querySelector(".progressStop-arc") as SVGElement
    expect(Number(arc.style.strokeDashoffset)).toBeCloseTo(0.58)
    expect(stop.querySelector(".progressStop-ring.indeterminate")).toBeNull()
    expect((row.querySelector(".modelPicker-select") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(stop)
    expect(api.cancelModelSelection).toHaveBeenCalled()
  })

  it("spins the ring for a phase that cannot measure itself", async () => {
    const { list } = await loading({ label: "Downloading llama.cpp" })
    const row = within(list).getByText("Qwen3.8 27B").closest(".modelPicker-row") as HTMLElement
    const stop = within(row).getByRole("button", { name: "Cancel model load" })
    expect(stop.getAttribute("title")).toBe("Cancel model load")
    expect(stop.querySelector(".progressStop-ring.indeterminate")).toBeTruthy()
    expect(within(row).getByText("Downloading llama.cpp")).toBeTruthy()
  })
})

describe("ModelPicker search", () => {
  it("lands on the active model each time it opens", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView")
    const { list } = await openPicker()
    const active = list.querySelector(".modelPicker-row.active") as HTMLElement
    expect(within(active).getByText("Kimi K2.6")).toBeTruthy()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" })
    expect(scrollIntoView.mock.instances).toEqual([active])
    // The rows stay mounted while closed, so a reopen lands on them again before the reload.
    fireEvent.keyDown(window, { key: "Escape" })
    scrollIntoView.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Kimi K2.6" }))
    await act(async () => {})
    expect(scrollIntoView.mock.instances).toEqual([active])
    scrollIntoView.mockRestore()
  })

  it("opens focused on the search box and lists every provider under its own header", async () => {
    const { dialog, search } = await openPicker()
    expect(document.activeElement).toBe(search)
    expect(search.placeholder).toBe("Search models")
    const headers = [...dialog.querySelectorAll(".popover-section")].map((e) => e.textContent)
    expect(headers).toEqual(["Local", "Fireworks AI", "Together AI"])
    expect(within(dialog).queryByText("Hosted")).toBeNull()
  })

  it("narrows rows by name, id, or provider and drops the headers of empty groups", async () => {
    const { dialog, list, search } = await openPicker()
    fireEvent.change(search, { target: { value: "kimi" } })
    expect(within(list).queryByText("Qwen3.8 27B")).toBeNull()
    expect(within(list).getByText("Kimi K2.6")).toBeTruthy()
    expect(within(list).getByText("Kimi K2.5")).toBeTruthy()
    let headers = [...dialog.querySelectorAll(".popover-section")].map((e) => e.textContent)
    expect(headers).toEqual(["Fireworks AI", "Together AI"])

    // Provider names match too, so "together" finds a row whose name says nothing about it.
    fireEvent.change(search, { target: { value: "TOGETHER" } })
    headers = [...dialog.querySelectorAll(".popover-section")].map((e) => e.textContent)
    expect(headers).toEqual(["Together AI"])
    expect(within(list).getByText("Kimi K2.5")).toBeTruthy()
    expect(within(list).queryByText("Kimi K2.6")).toBeNull()

    // An id's slug matches; its folders and organization do not.
    fireEvent.change(search, { target: { value: "k2p6" } })
    expect(within(list).getByText("Kimi K2.6")).toBeTruthy()
    expect(within(list).queryByText("Kimi K2.5")).toBeNull()
    fireEvent.change(search, { target: { value: "accounts" } })
    expect(within(dialog).getByText("No models match")).toBeTruthy()

    fireEvent.change(search, { target: { value: "no such model" } })
    expect(within(dialog).getByText("No models match")).toBeTruthy()
    expect(dialog.querySelectorAll(".modelPicker-row")).toHaveLength(0)
    expect(dialog.querySelectorAll(".popover-section")).toHaveLength(0)
  })

  it("keeps selection and deletion working on filtered rows", async () => {
    const deleteLocalModel = vi.fn(async () => ({ ok: true as const }))
    const { api, dialog, list, search } = await openPicker({ deleteLocalModel })
    fireEvent.change(search, { target: { value: "qwen" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Qwen3.8 27B" }))
    expect(within(dialog).getByText("Delete Qwen3.8 27B?")).toBeTruthy()
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep" }))
    expect(deleteLocalModel).not.toHaveBeenCalled()

    fireEvent.change(search, { target: { value: "k2.5" } })
    fireEvent.click(within(list).getByText("Kimi K2.5"))
    await act(async () => {})
    expect(api.selectModel).toHaveBeenCalledWith("together:moonshotai/Kimi-K2.5")
  })

  it("Escape clears the query before it closes the catalog", async () => {
    const { list, search } = await openPicker()
    fireEvent.change(search, { target: { value: "kimi" } })
    expect(within(list).queryByText("Qwen3.8 27B")).toBeNull()

    fireEvent.keyDown(window, { key: "Escape" })
    expect(search.value).toBe("")
    expect(within(list).getByText("Qwen3.8 27B")).toBeTruthy()
    expect(screen.getByRole("dialog", { name: "Select a model" })).toBeTruthy()

    fireEvent.keyDown(window, { key: "Escape" })
    await act(async () => {})
    expect(screen.queryByRole("dialog", { name: "Select a model" })).toBeNull()
  })
})
