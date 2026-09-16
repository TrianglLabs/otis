import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Script } from "node:vm"
import { createServer, type ViteDevServer } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { inlineCanvas } from "../../scripts/vite-inline-canvas.js"

const root = resolve("src/desktop/renderer")
const canvasHtml = resolve(root, "canvas.html")
const canvasRuntime = resolve(root, "canvas.js")
let server: ViteDevServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe("inline Canvas build", () => {
  it("keeps Vite outside the sandbox and asks the parent renderer to reload Canvas changes", async () => {
    server = await createServer({
      configFile: false,
      root,
      plugins: [inlineCanvas()],
      // This test exercises HTML transforms and reload events, not dependency pre-bundling.
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    })

    const html = await server.transformIndexHtml("/canvas.html", await readFile(canvasHtml, "utf8"))
    expect(html).not.toContain("/@vite/client")
    expect(html).toContain('data-otis-canvas-script="mermaid"')
    expect(html).toContain('data-otis-canvas-script="renderer"')
    // It executes as a classic inline script, with no module loader inside the opaque-origin frame.
    expect(
      () => new Script(html.match(/<script data-otis-canvas-script="renderer">([\s\S]*?)<\/script>/)?.[1] ?? ""),
    ).not.toThrow()

    const send = vi.spyOn(server.ws, "send").mockImplementation(() => {})
    server.watcher.emit("change", canvasRuntime)
    expect(send).toHaveBeenCalledWith({ type: "custom", event: "otis:canvas-reload", data: {} })
  })
})
