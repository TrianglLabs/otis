// @vitest-environment happy-dom

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, it, vi } from "vitest"

/** The preview host's inline script, run against the same iframe markup it ships with. */
async function loadWebpageHost() {
  const html = await readFile(resolve("src/desktop/renderer/webpage.html"), "utf8")
  const markup = /<iframe[^>]*><\/iframe>/.exec(html)?.[0]
  const script = /<script>([\s\S]*?)<\/script>\s*<\/body>/.exec(html)?.[1]
  if (!markup || !script) throw new Error("webpage.html changed shape")
  document.body.innerHTML = markup
  const listen = vi.spyOn(window, "addEventListener")
  new Function(script)()
  const receive = listen.mock.calls.find(([type]) => type === "message")[1]
  listen.mockRestore()
  return { frame: document.getElementById("preview"), receive }
}

it("relays link clicks from the preview to the app and only from its own frame", async () => {
  const { frame, receive } = await loadWebpageHost()
  const notify = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {})
  expect(frame.contentWindow).toBeTruthy()
  receive({
    source: window.parent,
    data: { type: "otis-webpage-source", source: "<a href='https://x.test/'>x</a>", title: "T" },
  })
  expect(frame.title).toBe("T")
  expect(frame.srcdoc).toContain("<a href='https://x.test/'>x</a>")
  expect(frame.srcdoc).toContain("otis-frame-link")
  expect(frame.srcdoc).toContain("otis-frame-find")
  expect(frame.srcdoc).toMatch(/<\/script>$/)
  receive({
    source: frame.contentWindow,
    data: { type: "otis-frame-link", url: "https://x.test/" },
  })
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    { type: "otis-frame-link", url: "https://x.test/" },
    "*",
  )
  receive({ source: {}, data: { type: "otis-frame-link", url: "https://evil.test/" } })
  receive({ source: {}, data: { type: "otis-frame-find", query: "x", index: 0 } })
  receive({
    source: frame.contentWindow,
    data: { type: "otis-webpage-source", source: "<p>no</p>", title: "N" },
  })
  expect(notify).toHaveBeenCalledOnce()
  expect(frame.srcdoc).not.toContain("<p>no</p>")
  window.removeEventListener("message", receive)
  notify.mockRestore()
  document.body.innerHTML = ""
})

it("relays view requests down to the page and its agent's answers back up, nothing else", async () => {
  const { frame, receive } = await loadWebpageHost()
  const notify = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {})
  const inner = vi.spyOn(frame.contentWindow, "postMessage").mockImplementation(() => {})
  receive({ source: window.parent, data: { type: "otis-frame-find", query: "a", index: 0 } })
  receive({ source: window.parent, data: { type: "otis-frame-zoom", zoom: 1.5 } })
  receive({ source: window.parent, data: { type: "otis-other", zoom: 1.5 } })
  expect(inner.mock.calls.map(([data]) => data.type)).toEqual([
    "otis-frame-find",
    "otis-frame-zoom",
  ])
  receive({ source: frame.contentWindow, data: { type: "otis-frame-matches", count: 3 } })
  receive({ source: frame.contentWindow, data: { type: "otis-frame-ready" } })
  receive({
    source: frame.contentWindow,
    data: { type: "otis-webpage-source", source: "x", title: "y" },
  })
  expect(notify.mock.calls.map(([data]) => data.type)).toEqual([
    "otis-frame-matches",
    "otis-frame-ready",
  ])
  expect(frame.srcdoc).toBe("")
  window.removeEventListener("message", receive)
  notify.mockRestore()
  inner.mockRestore()
  document.body.innerHTML = ""
})
