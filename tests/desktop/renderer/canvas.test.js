// @vitest-environment happy-dom

import { expect, it, vi } from "vitest"
import { uk } from "../../../src/desktop/renderer/i18n/messages/uk.js"

it("localizes Canvas controls and existing errors without rerendering the diagram", async () => {
  document.body.innerHTML =
    '<div id="diagram"></div><div id="error"></div><div id="viewport"></div><div id="controls"></div><button id="zoom-out"></button><button id="zoom-in"></button><button id="reset-view"></button>'
  const listen = vi.spyOn(window, "addEventListener")
  await import("../../../src/desktop/renderer/canvas.js")
  const receive = listen.mock.calls.find(([type]) => type === "message")[1]
  listen.mockRestore()
  const notify = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {})
  const send = (data, source = window.parent) => receive({ source, data })
  const keys = [
    "viewport",
    "controls",
    "zoomOut",
    "resetView",
    "zoomIn",
    "renderFailed",
    "loadFailed",
    "emptySource",
    "tooLarge",
  ]
  const language = {
    type: "otis-canvas-language",
    locale: "uk",
    labels: Object.fromEntries(keys.map((key) => [key, uk[`canvas.${key}`]])),
  }
  send(language, {})
  expect(document.getElementById("zoom-in").title).toBe("")
  send({
    type: "otis-canvas-source",
    source: "",
    colors: { background: "white", surface: "white", text: "black", muted: "gray", accent: "blue", border: "gray" },
  })
  expect(document.getElementById("error").textContent).toContain("The Mermaid block is empty.")
  expect(notify).toHaveBeenLastCalledWith(
    { type: "otis-canvas-render", ok: false, message: "The Mermaid block is empty." },
    "*",
  )
  send(language)
  expect(document.getElementById("zoom-in").title).toBe("Збільшити")
  expect(document.getElementById("viewport").getAttribute("aria-label")).toBe(uk["canvas.viewport"])
  expect(document.getElementById("error").textContent).toBe(
    `${uk["canvas.renderFailed"]}\n\n${uk["canvas.emptySource"]}`,
  )
  expect(document.documentElement.lang).toBe("uk")
  document.getElementById("zoom-in").click()
  expect(document.getElementById("reset-view").textContent).toBe("120%")
  send(language)
  expect(document.getElementById("reset-view").textContent).toBe("120%")
  window.removeEventListener("message", receive)
  notify.mockRestore()
  document.body.innerHTML = ""
})
