import { spawn } from "node:child_process"
import { childProcessEnvironment } from "../local/paths.js"
import type { ToolContext, ToolResult } from "./types.js"

const MAX_OUTPUT = 32_000
const TRUNCATION_MARKER = "[output truncated]\n"
const KILL_GRACE_MS = 2_000

export async function runBash(
  command: string,
  timeoutMs = 120_000,
  context: ToolContext,
): Promise<ToolResult> {
  const { signal } = context
  const output = await new Promise<string>((resolve) => {
    if (signal?.aborted) {
      resolve("Aborted.")
      return
    }
    const child = spawn(process.env.SHELL || "/bin/sh", ["-lc", command], {
      cwd: context.cwd ?? process.cwd(),
      env: childProcessEnvironment(process.env),
      detached: process.platform !== "win32",
    })
    let output = ""
    let timedOut = false
    let aborted = false
    let settled = false
    let forceKillTimer: NodeJS.Timeout | undefined

    const settle = (result: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      signal?.removeEventListener("abort", abort)
      resolve(result)
    }
    const report = (code?: number | null, closeSignal?: NodeJS.Signals | null) => {
      const status = aborted
        ? "Aborted."
        : timedOut
          ? `Timed out after ${timeoutMs}ms.`
          : `Exit code: ${code ?? "unknown"}${closeSignal ? `, signal: ${closeSignal}` : ""}.`
      settle(`${status}\n\n${output}`.trim())
    }
    const terminate = (termination: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === "win32") child.kill(termination)
        else process.kill(-child.pid, termination)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return
        try {
          child.kill(termination)
        } catch {
          // The process may have exited between group and direct termination.
        }
      }
    }
    const terminateThenForce = () => {
      terminate("SIGTERM")
      forceKillTimer = setTimeout(() => {
        terminate("SIGKILL")
        report()
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
    const append = (chunk: Buffer) => {
      output += String(chunk)
      if (output.length > MAX_OUTPUT) {
        const tail = output.slice(output.length - MAX_OUTPUT + TRUNCATION_MARKER.length)
        output = `${TRUNCATION_MARKER}${tail}`
      }
    }

    signal?.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.on("error", (error) => settle(`Failed to start command: ${error.message}`))
    child.on("close", report)
  })
  return { title: `Bash: ${command}`, output }
}
