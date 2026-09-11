import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import react from "@vitejs/plugin-react"
import electron from "electron"
import { build } from "vite"

// Real Electron layout with a fake DesktopApi. No provider, workspace, installed app, or browser automation is used.
const output = await mkdtemp(join(tmpdir(), "otis-desktop-ui-"))
try {
  await build({
    configFile: false,
    root: resolve("tests/desktop/ui"),
    base: "./",
    plugins: [react()],
    build: { outDir: output, emptyOutDir: true },
  })
  const code = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(electron as unknown as string, [resolve("tests/desktop/ui/run.cjs"), output], {
      stdio: "inherit",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    })
    child.on("error", reject)
    child.on("exit", (code) => resolveExit(code ?? 1))
  })
  process.exitCode = code
} finally {
  await rm(output, { recursive: true, force: true })
}
