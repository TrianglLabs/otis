import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import electron from "electron"

// This app has its own profile, no model, and no credentials. It intentionally loses its renderer and stdio.
const output = await mkdtemp(join(tmpdir(), "otis-desktop-lifecycle-"))
try {
  const built = await Bun.build({
    entrypoints: [resolve("tests/desktop/lifecycle/run.ts")],
    outdir: output,
    naming: "run.cjs",
    target: "node",
    format: "cjs",
    external: ["electron"],
  })
  if (!built.success) throw new AggregateError(built.logs, "Unable to build lifecycle test")
  const code = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(electron as unknown as string, [join(output, "run.cjs"), output], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    })
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Desktop lifecycle checks timed out"))
    }, 30_000)
    let stdout = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
      if (!stdout.includes("READY\n")) return
      // Reproduce a tool/terminal closing the pipes while Electron remains alive.
      child.stdout.destroy()
      child.stderr.destroy()
      child.stdin.end("disconnect\n")
    })
    child.stderr.resume()
    child.stdin.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on("exit", (code) => {
      clearTimeout(timeout)
      resolveExit(code ?? 1)
    })
  })
  const result = await readFile(join(output, "result.json"), "utf8").catch(() => "No lifecycle test result")
  console.log(result)
  if (code !== 0) throw new Error(`Desktop lifecycle checks exited with ${code}`)
} finally {
  await rm(output, { recursive: true, force: true })
}
