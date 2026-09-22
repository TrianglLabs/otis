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
  expect(frame.srcdoc).toContain("otis-webpage-link")
  expect(frame.srcdoc).toMatch(/<\/script>$/)
  receive({
    source: frame.contentWindow,
    data: { type: "otis-webpage-link", url: "https://x.test/" },
  })
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    { type: "otis-webpage-link", url: "https://x.test/" },
    "*",
  )
  receive({ source: {}, data: { type: "otis-webpage-link", url: "https://evil.test/" } })
  receive({ source: frame.contentWindow, data: { type: "otis-webpage-link", url: 7 } })
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
