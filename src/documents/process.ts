import { spawn } from "node:child_process"

export type DocumentProcessOptions = { cwd: string; signal?: AbortSignal; timeoutMs?: number }
export type DocumentProcessRunner = typeof runDocumentProcess

/** Fixed executable and argument arrays only. Document helpers never inherit provider credentials. */
export function runDocumentProcess(command: string, args: string[], options: DocumentProcessOptions): Promise<string> {
  options.signal?.throwIfAborted()
  const env: NodeJS.ProcessEnv = {}
  for (const name of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  // Disable pip configuration files, including machine-wide indexes. All packages come from the fixed manifest.
  env.PIP_CONFIG_FILE = process.platform === "win32" ? "NUL" : "/dev/null"
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    let failure: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === "win32") child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch {
        // The process may already have exited.
      }
    }
    const stop = (error: Error) => {
      if (failure) return
      failure = error
      kill("SIGTERM")
      killTimer = setTimeout(() => kill("SIGKILL"), 1000)
    }
    const abort = () => stop(new Error("Document operation cancelled."))
    const timer = setTimeout(() => stop(new Error("Document operation timed out.")), options.timeoutMs ?? 240_000)
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    child.stdin.end()
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length + chunk.length > 512_000) stop(new Error("Document output is too large; inspect fewer pages."))
      else stdout += chunk
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_000)
    })
    child.on("error", (error) => {
      failure ??= error
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener("abort", abort)
      if (failure) {
        kill("SIGKILL")
        reject(failure)
      } else if (code !== 0) reject(new Error(stderr.trim() || `Document process failed (exit ${code}).`))
      else resolve(stdout.trim())
    })
  })
}
