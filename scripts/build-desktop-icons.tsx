import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"
import { OtisMark } from "../src/desktop/renderer/components/OtisMark.js"
import { THEME_NAMES } from "../src/local/settings.js"

// Asset authoring runs on macOS, where iconutil creates the native ICNS representations.
// Normal desktop builds consume the checked-in assets and do not run Electron to generate them.
if (process.platform !== "darwin") throw new Error("Generate desktop icons on macOS (requires iconutil).")

const root = fileURLToPath(new URL("..", import.meta.url))
const electronPath: string = createRequire(import.meta.url)("electron")
const resources = join(root, "resources")
const temporary = await mkdtemp(join(tmpdir(), "otis-desktop-icons-"))
try {
  await mkdir(join(resources, "icons"), { recursive: true })
  const styles = await Promise.all(
    ["tokens", "themes"].map((name) => readFile(join(root, `src/desktop/renderer/styles/${name}.css`), "utf8")),
  )
  const mark = renderToStaticMarkup(<OtisMark />)
  for (const theme of THEME_NAMES) {
    await writeFile(
      join(temporary, `${theme}.html`),
      `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>${styles.join("\n")}
html, body { margin: 0; width: 1024px; height: 1024px; background: transparent; }
.tile { position: absolute; inset: 100px; display: grid; place-items: center;
  border-radius: 184px; background: var(--bg); }
.tile svg { width: 680px; height: auto; color: var(--text); }
</style></head><body><div class="tile">${mark}</div></body></html>`,
    )
  }
  execFileSync(electronPath, [join(root, "scripts/render-desktop-icons.cjs"), temporary, resources, ...THEME_NAMES], {
    stdio: "inherit",
  })
  execFileSync("iconutil", ["-c", "icns", join(temporary, "icon.iconset"), "-o", join(resources, "icon.icns")], {
    stdio: "inherit",
  })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
