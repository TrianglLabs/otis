// @vitest-environment happy-dom

import { expect, it, vi } from "vitest"
import { uk } from "../../../src/desktop/renderer/i18n/messages/uk.js"

it("localizes Canvas controls and existing errors without rerendering the diagram", async () => {
  document.body.innerHTML =
    '<div id="diagram"></div><div id="error"></div><div id="viewport"></div>'
  const listen = vi.spyOn(window, "addEventListener")
  await import("../../../src/desktop/renderer/canvas.js")
  const receive = listen.mock.calls.find(([type]) => type === "message")[1]
  listen.mockRestore()
  const notify = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {})
  const send = (data, source = window.parent) => receive({ source, data })
  const keys = ["viewport", "renderFailed", "loadFailed", "emptySource", "tooLarge"]
  const language = {
    type: "otis-canvas-language",
    locale: "uk",
    labels: Object.fromEntries(keys.map((key) => [key, uk[`canvas.${key}`]])),
  }
  send(language, {})
  expect(document.getElementById("viewport").getAttribute("aria-label")).toBeNull()
  send({
    type: "otis-canvas-source",
    source: "",
    colors: {
      background: "white",
      surface: "white",
      text: "black",
      muted: "gray",
      accent: "blue",
      border: "gray",
    },
  })
  expect(document.getElementById("error").textContent).toContain("The Mermaid block is empty.")
  expect(notify).toHaveBeenLastCalledWith(
    { type: "otis-canvas-render", ok: false, message: "The Mermaid block is empty." },
    "*",
  )
  send(language)
  expect(document.getElementById("viewport").getAttribute("aria-label")).toBe(uk["canvas.viewport"])
  expect(document.getElementById("error").textContent).toBe(
    `${uk["canvas.renderFailed"]}\n\n${uk["canvas.emptySource"]}`,
  )
  expect(document.documentElement.lang).toBe("uk")
  window.removeEventListener("message", receive)
  notify.mockRestore()
  document.body.innerHTML = ""
})

it("keeps zoom and pan across a theme re-render and resets them for a new diagram", async () => {
  document.body.innerHTML =
    '<div id="diagram"></div><div id="error"></div><div id="viewport"></div>'
  vi.resetModules()
  const listen = vi.spyOn(window, "addEventListener")
  await import("../../../src/desktop/renderer/canvas.js")
  const receive = listen.mock.calls.find(([type]) => type === "message")[1]
  listen.mockRestore()
  const notify = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {})
  vi.stubGlobal("mermaid", {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 320 120"></svg>' })),
  })
  const colors = (accent) => ({
    background: "white",
    surface: "white",
    text: "black",
    muted: "gray",
    accent,
    border: "gray",
  })
  const send = (source, accent) =>
    receive({
      source: window.parent,
      data: { type: "otis-canvas-source", source, colors: colors(accent) },
    })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  send("graph TD; A-->B", "blue")
  await settle()
  expect(notify).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "otis-canvas-render", ok: true }),
    "*",
  )
  // The parent's pill asks for steps; every change of view reports the scale back.
  const zoom = (data) =>
    receive({ source: window.parent, data: { type: "otis-canvas-zoom", ...data } })
  const scale = () => notify.mock.calls.findLast(([m]) => m.type === "otis-canvas-view")[0].scale
  zoom({ factor: 1.2 })
  zoom({ factor: 1.2 })
  expect(scale()).toBeCloseTo(1.44)
  send("graph TD; A-->B", "red")
  await settle()
  expect(globalThis.mermaid.render).toHaveBeenCalledTimes(2)
  expect(scale()).toBeCloseTo(1.44)
  send("graph TD; A-->C", "red")
  await settle()
  expect(scale()).toBe(1)
  zoom({ factor: 1.2 })
  zoom({ reset: true })
  expect(scale()).toBe(1)
  window.removeEventListener("message", receive)
  notify.mockRestore()
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

it("takes its full width when large and asks to close on Escape only then", async () => {
  document.body.innerHTML =
    '<div id="diagram"></div><div id="error"></div><div id="viewport"></div>'
  vi.resetModules()
  const listen = vi.spyOn(window, "addEventListener")
  await import("../../../src/desktop/renderer/canvas.js")
  const receive = listen.mock.calls.find(([type]) => type === "message")[1]
  listen.mockRestore()
  const notify = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {})
  vi.stubGlobal("mermaid", {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 1200 400"></svg>' })),
  })
  const colors = {
    background: "white",
    surface: "white",
    text: "black",
    muted: "gray",
    accent: "blue",
    border: "gray",
  }
  const send = (large) =>
    receive({
      source: window.parent,
      data: { type: "otis-canvas-source", source: "graph TD; A-->B", large, colors },
    })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const pressEscape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  send(false)
  await settle()
  expect(document.documentElement.classList.contains("large")).toBe(false)
  // Escape is only the frame's to answer while it is large.
  pressEscape()
  expect(notify.mock.calls.some(([m]) => m.type === "otis-canvas-enlarge")).toBe(false)
  send(true)
  await settle()
  expect(document.documentElement.classList.contains("large")).toBe(true)
  pressEscape()
  expect(notify).toHaveBeenLastCalledWith({ type: "otis-canvas-enlarge", open: false }, "*")
  window.removeEventListener("message", receive)
  notify.mockRestore()
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})
