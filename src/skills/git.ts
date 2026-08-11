import { spawn } from "node:child_process"
import { childProcessEnvironment } from "../local/child-environment.js"

const MAX_GIT_OUTPUT = 32_000

export type GitRunner = (args: readonly string[], options?: { cwd?: string }) => Promise<string>

export const runGit: GitRunner = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: options.cwd,
      env: childProcessEnvironment(process.env),
      stdio: ["inherit", "pipe", "pipe"],
    })
    let output = ""
    const append = (chunk: unknown) => {
      output = `${output}${String(chunk)}`.slice(-MAX_GIT_OUTPUT)
    }
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.on("error", (error) => reject(new Error(`Could not run git: ${error.message}`)))
    child.on("close", (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`Git command failed (${code ?? "unknown"}): ${output.trim() || args.join(" ")}`))
    })
  })
