// @vitest-environment happy-dom

import { expect, it, vi } from "vitest"
import { uk } from "../../../src/desktop/renderer/i18n/messages/uk.js"

const colors = {
  background: "white",
  surface: "white",
  text: "black",
  muted: "gray",
  accent: "blue",
  border: "gray",
  cyan: "cyan",
  green: "green",
  orange: "orange",
  pink: "pink",
  yellow: "yellow",
}

const drawing = (width, height) => ({
  svg: `<svg viewBox="0 0 ${width} ${height}"></svg>`,
  width,
  height,
})

/**
 * A fresh frame: the document it expects, the script loaded anew, its message handler to call as
 * the parent would, the parent's postMessage spied, and a teardown that takes every listener the
 * script registered on the shared window back down with it.
 */
async function loadCanvas(pele = { render: vi.fn(() => drawing(320, 120)) }) {
  document.body.innerHTML =
    '<div id="diagram" hidden></div><pre id="error" hidden></pre><div id="viewport"></div>'
  vi.stubGlobal("pele", pele)
  vi.resetModules()
  const listen = vi.spyOn(window, "addEventListener")
  await import("../../../src/desktop/renderer/canvas.js")
  const listeners = listen.mock.calls.map(([type, listener]) => [type, listener])
  listen.mockRestore()
  const notify = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {})
  return {
    pele,
    notify,
    send: (data, source = window.parent) =>
      listeners.find(([type]) => type === "message")[1]({ source, data }),
    done: () => {
      for (const [type, listener] of listeners) window.removeEventListener(type, listener)
      notify.mockRestore()
      vi.unstubAllGlobals()
      document.body.innerHTML = ""
    },
  }
}

it("localizes Canvas controls and existing errors without rerendering the diagram", async () => {
  const frame = await loadCanvas()
  const keys = ["viewport", "renderFailed", "loadFailed", "emptySource", "tooLarge"]
  const language = {
    type: "otis-canvas-language",
    locale: "uk",
    labels: Object.fromEntries(keys.map((key) => [key, uk[`canvas.${key}`]])),
  }
  frame.send(language, {})
  expect(document.getElementById("viewport").getAttribute("aria-label")).toBeNull()
  frame.send({ type: "otis-canvas-source", source: "", colors })
  expect(document.getElementById("error").textContent).toContain("The Mermaid block is empty.")
  expect(frame.notify).toHaveBeenLastCalledWith(
    { type: "otis-canvas-render", ok: false, message: "The Mermaid block is empty." },
    "*",
  )
  frame.send(language)
  expect(document.getElementById("viewport").getAttribute("aria-label")).toBe(uk["canvas.viewport"])
  expect(document.getElementById("error").textContent).toBe(
    `${uk["canvas.renderFailed"]}\n\n${uk["canvas.emptySource"]}`,
  )
  expect(document.documentElement.lang).toBe("uk")
  expect(frame.pele.render).not.toHaveBeenCalled()
  frame.done()
})

it("lays the drawing out for the width it has, in the parent's text size, and again when that width changes", async () => {
  const frame = await loadCanvas()
  let viewportWidth = 800
  Object.defineProperty(document.getElementById("viewport"), "clientWidth", {
    get: () => viewportWidth,
  })
  const resize = () => window.dispatchEvent(new Event("resize"))
  const source = "graph LR; A-->B"
  // Nothing on screen yet: a resize lays nothing out.
  resize()
  expect(frame.pele.render).not.toHaveBeenCalled()
  // A tab keeps 24px clear on each side of the drawing, up to the drawing's cap.
  frame.send({ type: "otis-canvas-source", source, colors, fontSize: 14 })
  expect(frame.pele.render).toHaveBeenLastCalledWith(
    source,
    expect.objectContaining({ maxWidth: 752, fontSize: 14 }),
  )
  viewportWidth = 1000
  resize()
  expect(frame.pele.render).toHaveBeenLastCalledWith(
    source,
    expect.objectContaining({ maxWidth: 760 }),
  )
  viewportWidth = 400
  resize()
  expect(frame.pele.render).toHaveBeenCalledTimes(3)
  expect(frame.pele.render).toHaveBeenLastCalledWith(
    source,
    expect.objectContaining({ maxWidth: 352 }),
  )
  // The parent fitting the frame's height to the drawing is not a change of width.
  resize()
  expect(frame.pele.render).toHaveBeenCalledTimes(3)
  // The dialog gives all but the margins; inline, the drawing may take the whole document width.
  viewportWidth = 1600
  frame.send({ type: "otis-canvas-source", source, colors, large: true })
  expect(frame.pele.render).toHaveBeenLastCalledWith(
    source,
    expect.objectContaining({ maxWidth: 1552 }),
  )
  viewportWidth = 400
  frame.send({ type: "otis-canvas-source", source, colors, inline: true, fontSize: 14 })
  expect(frame.pele.render).toHaveBeenLastCalledWith(
    source,
    expect.objectContaining({ maxWidth: 400, fontSize: 14 }),
  )
  frame.done()
})

it("shows what Pele could not parse, in the error view and to the parent", async () => {
  const frame = await loadCanvas({
    render: vi.fn(() => {
      throw new Error("Unexpected token at line 2")
    }),
  })
  frame.send({ type: "otis-canvas-source", source: "flowchart LR\n  A --> ", colors })
  expect(document.getElementById("diagram").hidden).toBe(true)
  expect(document.getElementById("error").textContent).toContain("Unexpected token at line 2")
  expect(frame.notify).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "otis-canvas-render",
      ok: false,
      message: "Unexpected token at line 2",
    }),
    "*",
  )
  frame.done()
})

it("keeps zoom and pan across a theme re-render and resets them for a new diagram", async () => {
  const frame = await loadCanvas()
  const send = (source, accent) =>
    frame.send({ type: "otis-canvas-source", source, colors: { ...colors, accent } })
  send("graph TD; A-->B", "blue")
  expect(frame.notify).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "otis-canvas-render", ok: true }),
    "*",
  )
  // The parent's pill asks for steps; every change of view reports the scale back.
  const zoom = (data) => frame.send({ type: "otis-canvas-zoom", ...data })
  const scale = () =>
    frame.notify.mock.calls.findLast(([m]) => m.type === "otis-canvas-view")[0].scale
  zoom({ factor: 1.2 })
  zoom({ factor: 1.2 })
  expect(scale()).toBeCloseTo(1.44)
  send("graph TD; A-->B", "red")
  expect(frame.pele.render).toHaveBeenCalledTimes(2)
  expect(scale()).toBeCloseTo(1.44)
  send("graph TD; A-->C", "red")
  expect(scale()).toBe(1)
  zoom({ factor: 1.2 })
  zoom({ reset: true })
  expect(scale()).toBe(1)
  frame.done()
})

it("takes its full width when large and asks to close on Escape only then", async () => {
  const frame = await loadCanvas({ render: vi.fn(() => drawing(1200, 400)) })
  const send = (large) =>
    frame.send({ type: "otis-canvas-source", source: "graph TD; A-->B", large, colors })
  const pressEscape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  send(false)
  expect(document.documentElement.classList.contains("large")).toBe(false)
  // Escape is only the frame's to answer while it is large.
  pressEscape()
  expect(frame.notify.mock.calls.some(([m]) => m.type === "otis-canvas-enlarge")).toBe(false)
  send(true)
  expect(document.documentElement.classList.contains("large")).toBe(true)
  pressEscape()
  expect(frame.notify).toHaveBeenLastCalledWith({ type: "otis-canvas-enlarge", open: false }, "*")
  frame.done()
})

it("stops a pan or zoom where the drawing would leave the viewport", async () => {
  const frame = await loadCanvas()
  // A laid-out frame: an 800×600 viewport with a 320×120 drawing centred near its top. Hidden,
  // the drawing measures nothing, as in a browser.
  const viewport = document.getElementById("viewport")
  const diagram = document.getElementById("diagram")
  Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 } })
  const laidOut = (value) => ({ get: () => (diagram.hidden ? 0 : value) })
  Object.defineProperties(diagram, {
    offsetWidth: laidOut(320),
    offsetHeight: laidOut(120),
    offsetLeft: laidOut(240),
    offsetTop: laidOut(24),
  })
  frame.send({ type: "otis-canvas-source", source: "graph TD; A-->B", colors })
  // A fresh render starts at rest: the drawing was shown and measured before the view applied.
  expect(diagram.style.transform).toBe("translate3d(0px, 0px, 0) scale(1)")
  const wheel = (deltaX, deltaY) =>
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaX, deltaY, cancelable: true }))
  // Far left and far down: 48px of the drawing stay inside on each axis.
  wheel(5000, 0)
  expect(diagram.style.transform).toBe("translate3d(-512px, 0px, 0) scale(1)")
  wheel(0, -5000)
  expect(diagram.style.transform).toBe("translate3d(-512px, 528px, 0) scale(1)")
  // Back within range, the pan is taken as asked.
  wheel(-100, 100)
  expect(diagram.style.transform).toBe("translate3d(-412px, 428px, 0) scale(1)")
  frame.done()
})
