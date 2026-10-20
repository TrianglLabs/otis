import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const canvasHtmlPath = resolve(repositoryRoot, "src/desktop/renderer/canvas.html")
const runtimePath = resolve(repositoryRoot, "src/desktop/renderer/canvas.js")
const pelePath = resolve(repositoryRoot, "node_modules/pele/dist/pele.global.js")
const canvasMarker = '<template id="otis-canvas-runtime"></template>'
const canvasReloadEvent = "otis:canvas-reload"

/**
 * Produces one self-contained document so a sandboxed file:// iframe never needs subresource
 * access.
 */
export function inlineCanvas(): Plugin {
  return {
    name: "otis-inline-canvas",
    enforce: "pre",
    configureServer(server) {
      const reloadCanvas = (path: string) => {
        if ([canvasHtmlPath, runtimePath].includes(resolve(path))) {
          server.ws.send({ type: "custom", event: canvasReloadEvent, data: {} })
        }
      }
      server.watcher.add([canvasHtmlPath, runtimePath])
      server.watcher.on("change", reloadCanvas)
      server.httpServer?.once("close", () => server.watcher.off("change", reloadCanvas))
    },
    async transformIndexHtml(html, context) {
      const path = context.path.split("?", 1)[0]
      if (!path.endsWith("/canvas.html") && path !== "canvas.html") return html
      // The sandbox gives Canvas an opaque origin, so Vite's injected client cannot load there.
      // The parent renderer owns HMR and remounts this frame when the custom event above arrives.
      if (context.server)
        html = html.replace(/<script type="module" src="[^"]*\/@vite\/client"><\/script>\s*/i, "")
      if (html.includes("data-otis-canvas-script")) return html
      const [pele, runtime] = await Promise.all([
        readFile(pelePath, "utf8"),
        readFile(runtimePath, "utf8"),
      ])
      if (!html.includes(canvasMarker))
        throw new Error("Canvas HTML is missing its runtime marker.")
      const scripts = [pele, runtime].map((source) =>
        source.replaceAll(/<\/script/gi, "<\\/script"),
      )
      return html.replace(
        canvasMarker,
        () =>
          `<script data-otis-canvas-script="pele">${scripts[0]}</script>\n    <script data-otis-canvas-script="renderer">${scripts[1]}</script>`,
      )
    },
  }
}
