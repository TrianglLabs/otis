import { readFile } from "node:fs/promises"
import { builtinModules } from "node:module"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"
import type { Plugin } from "vite"

const root = fileURLToPath(new URL(".", import.meta.url))

/** Mirrors Bun's built-in text loader (`import … with { type: "text" }`) for the system-prompt asset. */
const inlineText: Plugin = {
  name: "otis-inline-text",
  enforce: "pre",
  async load(id) {
    if (!id.endsWith(".txt")) return null
    return `export default ${JSON.stringify(await readFile(id, "utf8"))}`
  },
}

/**
 * The shipped CSP in index.html is strict (`script-src 'self'`). The dev server needs an inline script for the
 * React Fast Refresh preamble and a websocket for HMR, so the policy is relaxed only while serving, never in
 * the built page.
 */
const devCsp: Plugin = {
  name: "otis-dev-csp",
  transformIndexHtml: {
    order: "pre",
    handler(html, ctx) {
      if (!ctx.server) return html
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws:")
    },
  },
}

// The "electron" builtin and Node builtins must never be bundled into the main/preload processes. Everything else
// (yaml, diff, …) is bundled so the packaged app does not depend on shipped node_modules.
const electronExternals = ["electron", /^electron\/.+/, ...builtinModules.flatMap((m) => [m, `node:${m}`])]

// Main and preload are forced to CJS: the sandboxed preload cannot be an ES module.
const cjsOutput = {
  format: "cjs" as const,
  entryFileNames: "[name].cjs",
  chunkFileNames: "[name]-[hash].cjs",
}

export default defineConfig({
  main: {
    plugins: [inlineText],
    build: {
      outDir: `${root}out/main`,
      rollupOptions: {
        input: { index: `${root}src/desktop/main/index.ts` },
        external: electronExternals,
        output: cjsOutput,
      },
    },
  },
  preload: {
    build: {
      outDir: `${root}out/preload`,
      rollupOptions: {
        input: { index: `${root}src/desktop/preload/index.ts` },
        external: electronExternals,
        output: cjsOutput,
      },
    },
  },
  renderer: {
    root: `${root}src/desktop/renderer`,
    plugins: [react(), devCsp],
    build: {
      outDir: `${root}out/renderer`,
      rollupOptions: {
        input: `${root}src/desktop/renderer/index.html`,
      },
    },
  },
})
