import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { renderTrayIcon, TRAY_ICON_SIZES, type TrayIconVariant } from "./tray-icon-render.js"

// Regenerates the tray template images checked in under resources/tray. Rerun after changing
// src/desktop/renderer/mark.ts (bun run build:desktop:tray). The generator is pure TypeScript, so
// no Apple tooling is required and the committed files can be verified byte-for-byte in tests.
const outDir = fileURLToPath(new URL("../resources/tray/", import.meta.url))
await mkdir(outDir, { recursive: true })

const variants: TrayIconVariant[] = ["idle", "working", "alert"]
const scales = [
  { size: TRAY_ICON_SIZES.base, suffix: "" },
  { size: TRAY_ICON_SIZES.retina, suffix: "@2x" },
]
for (const variant of variants) {
  const name = variant.charAt(0).toUpperCase() + variant.slice(1)
  for (const { size, suffix } of scales) {
    await writeFile(join(outDir, `otis${name}Template${suffix}.png`), renderTrayIcon(size, variant))
  }
}
console.log(`Generated ${variants.length * scales.length} tray template images in resources/tray.`)
