import { readFile } from "node:fs/promises"
import type { Plugin } from "vite"

/** Mirrors Bun's text imports for prompts and embedded skill resources. */
export function inlineText(): Plugin {
  return {
    name: "otis-inline-text",
    enforce: "pre",
    async load(id) {
      if (!/\.(txt|md|py)$/.test(id)) return null
      return {
        code: `export default ${JSON.stringify(await readFile(id, "utf8"))}`,
        // The loader already emitted JavaScript; .txt must not be wrapped as text a second time.
        moduleType: "js",
      }
    },
  }
}
