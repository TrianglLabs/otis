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
    hasDownloadedPacking: true,
    cpuOffload: false,
    downloaded: true,
    active: false,
  },
  { kind: "header", id: "header-fireworks", displayName: "Fireworks" },
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
  await within(dialog).findByText("Qwen3.8 27B")
  return { api, dialog, search: within(dialog).getByLabelText("Search models") as HTMLInputElement }
}

afterEach(() => cleanup())

describe("ModelPicker search", () => {
  it("opens focused on the search box and lists every provider under its own header", async () => {
    const { dialog, search } = await openPicker()
    expect(document.activeElement).toBe(search)
    expect(search.placeholder).toBe("Search models")
    const headers = [...dialog.querySelectorAll(".modelPicker-header")].map((e) => e.textContent)
    expect(headers).toEqual(["Local", "Fireworks", "Together AI"])
    expect(within(dialog).queryByText("Hosted")).toBeNull()
  })

  it("narrows rows by name, id, or provider and drops the headers of empty groups", async () => {
    const { dialog, search } = await openPicker()
    fireEvent.change(search, { target: { value: "kimi" } })
    expect(within(dialog).queryByText("Qwen3.8 27B")).toBeNull()
    expect(within(dialog).getByText("Kimi K2.6")).toBeTruthy()
    expect(within(dialog).getByText("Kimi K2.5")).toBeTruthy()
    let headers = [...dialog.querySelectorAll(".modelPicker-header")].map((e) => e.textContent)
    expect(headers).toEqual(["Fireworks", "Together AI"])

    // Provider names match too, so "together" finds a row whose name says nothing about it.
    fireEvent.change(search, { target: { value: "TOGETHER" } })
    headers = [...dialog.querySelectorAll(".modelPicker-header")].map((e) => e.textContent)
    expect(headers).toEqual(["Together AI"])
    expect(within(dialog).getByText("Kimi K2.5")).toBeTruthy()
    expect(within(dialog).queryByText("Kimi K2.6")).toBeNull()

    fireEvent.change(search, { target: { value: "accounts/fireworks" } })
    expect(within(dialog).getByText("Kimi K2.6")).toBeTruthy()
    expect(within(dialog).queryByText("Kimi K2.5")).toBeNull()

    fireEvent.change(search, { target: { value: "no such model" } })
    expect(within(dialog).getByText("No models match")).toBeTruthy()
    expect(dialog.querySelectorAll(".modelPicker-row")).toHaveLength(0)
    expect(dialog.querySelectorAll(".modelPicker-header")).toHaveLength(0)
  })

  it("keeps selection and deletion working on filtered rows", async () => {
    const deleteLocalModel = vi.fn(async () => ({ ok: true as const }))
    const { api, dialog, search } = await openPicker({ deleteLocalModel })
    fireEvent.change(search, { target: { value: "qwen" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Qwen3.8 27B" }))
    expect(within(dialog).getByText("Delete Qwen3.8 27B?")).toBeTruthy()
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep" }))
    expect(deleteLocalModel).not.toHaveBeenCalled()

    fireEvent.change(search, { target: { value: "k2.5" } })
    fireEvent.click(within(dialog).getByText("Kimi K2.5"))
    await act(async () => {})
    expect(api.selectModel).toHaveBeenCalledWith("moonshotai/Kimi-K2.5")
  })

  it("Escape clears the query before it closes the catalog", async () => {
    const { dialog, search } = await openPicker()
    fireEvent.change(search, { target: { value: "kimi" } })
    expect(within(dialog).queryByText("Qwen3.8 27B")).toBeNull()

    fireEvent.keyDown(window, { key: "Escape" })
    expect(search.value).toBe("")
    expect(within(dialog).getByText("Qwen3.8 27B")).toBeTruthy()
    expect(screen.getByRole("dialog", { name: "Select a model" })).toBeTruthy()

    fireEvent.keyDown(window, { key: "Escape" })
    await act(async () => {})
    expect(screen.queryByRole("dialog", { name: "Select a model" })).toBeNull()
  })
})
