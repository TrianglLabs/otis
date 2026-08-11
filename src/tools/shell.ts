import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { childProcessEnvironment } from "../local/child-environment.js"
import type { ToolContext, ToolResult } from "./types.js"

const MAX_OUTPUT = 32_000
const TRUNCATION_MARKER = "[output truncated]\n"
const KILL_GRACE_MS = 2_000

export async function runBash(command: string, timeoutMs = 120_000, context: ToolContext): Promise<ToolResult> {
  return {
    title: `Bash: ${command}`,
    output: await executeShell(command, context.cwd ?? process.cwd(), timeoutMs, context.signal),
  }
}

function executeShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<string>((resolve) => {
    if (signal?.aborted) {
      resolve("Aborted.")
      return
    }

    const child = spawn(process.env.SHELL || "/bin/sh", ["-lc", command], {
      cwd,
      env: childProcessEnvironment(process.env),
      detached: process.platform !== "win32",
    })
    let output = ""
    let timedOut = false
    let aborted = false
    let settled = false
    let forceKillTimer: NodeJS.Timeout | undefined

    const finish = (result: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      signal?.removeEventListener("abort", abort)
      resolve(result)
    }
    const terminateThenForce = () => {
      terminateShell(child, "SIGTERM")
      forceKillTimer = setTimeout(() => {
        terminateShell(child, "SIGKILL")
        finish(formatShellResult({ output, timedOut, aborted, timeoutMs }))
      }, KILL_GRACE_MS)
    }
    const abort = () => {
      aborted = true
      terminateThenForce()
    }
    const timeoutTimer = setTimeout(
      () => {
        timedOut = true
        terminateThenForce()
      },
      Math.max(1, timeoutMs),
    )

    signal?.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", (chunk) => {
      output = appendBounded(output, String(chunk))
    })
    child.stderr.on("data", (chunk) => {
      output = appendBounded(output, String(chunk))
    })
    child.on("error", (error) => finish(`Failed to start command: ${error.message}`))
    child.on("close", (code, closeSignal) => {
      finish(formatShellResult({ output, timedOut, aborted, timeoutMs, code, signal: closeSignal }))
    })
  })
}

function terminateShell(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (!child.pid) return

  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (isNoSuchProcessError(error)) return
    try {
      child.kill(signal)
    } catch {
      // The process may have exited between group and direct termination.
    }
  }
}

function isNoSuchProcessError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
}

function formatShellResult(options: {
  output: string
  timedOut: boolean
  aborted: boolean
  timeoutMs?: number
  code?: number | null
  signal?: NodeJS.Signals | null
}) {
  const status = options.aborted
    ? "Aborted."
    : options.timedOut
      ? `Timed out after ${options.timeoutMs ?? "unknown"}ms.`
      : `Exit code: ${options.code ?? "unknown"}${options.signal ? `, signal: ${options.signal}` : ""}.`
  return `${status}\n\n${options.output}`.trim()
}

function appendBounded(current: string, chunk: string) {
  const next = current + chunk
  if (next.length <= MAX_OUTPUT) return next
  return `${TRUNCATION_MARKER}${next.slice(next.length - MAX_OUTPUT + TRUNCATION_MARKER.length)}`
}
