import { basename, dirname, resolve } from "node:path"
import { resolveConfig } from "electron-vite"
import { build } from "vite"

// Exercise the shipped main-process build configuration, substituting only the entry and output.
const { config } = await resolveConfig({ configFile: resolve("electron.vite.config.ts") }, "build")
if (!config?.main) throw new Error("Desktop main-process build configuration is missing")
await build({
  ...config.main,
  configFile: false,
  logLevel: "silent",
  build: {
    ...config.main.build,
    outDir: dirname(process.argv[2]),
    emptyOutDir: false,
    rollupOptions: {
      ...config.main.build?.rollupOptions,
      input: resolve("tests/skills/support/load-bundled.ts"),
      output: { format: "cjs", entryFileNames: basename(process.argv[2]) },
    },
  },
})
