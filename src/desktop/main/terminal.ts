import { userInfo } from "node:os"
import type { IPty, spawn } from "node-pty"
import { findOnPath } from "../../local/paths.js"

export type SpawnPty = typeof spawn

const FLUSH_INTERVAL_MS = 16
/** Retained output, in characters; the oldest whole lines go first once it is exceeded. */
const HISTORY_LIMIT = 1_000_000

/**
 * The workspace's shell behind a pseudo-terminal: the login shell, or on Windows PowerShell 7
 * when installed, else the Windows PowerShell every system has, with its banner off. The agent's
 * own commands run through Git Bash instead (src/local/paths.ts). Output is coalesced per frame
 * before it crosses to the renderer, so a build's stream of small writes does not become a stream
 * of IPC messages, and retained so a renderer that comes back, or comes later, can replay it.
 * The shell starts at the first size the view reports, so its first lines fit the grid they are
 * shown on: zsh's end-of-line mark, padded to the width it starts at, would otherwise wrap into a
 * stray % above the prompt.
 */
export class WorkspaceTerminal {
  #pty: IPty | undefined
  #pending = ""
  #flush: ReturnType<typeof setTimeout> | undefined
  #history = ""

  constructor(
    private readonly spawnPty: SpawnPty,
    private readonly cwd: string,
    private readonly send: (data: string) => void,
    private readonly onExit: () => void,
    private readonly platform: NodeJS.Platform,
  ) {}

  get history() {
    return this.#history
  }

  write(data: string) {
    this.#pty?.write(data)
  }

  resize(cols: number, rows: number) {
    if (this.#pty) return this.#pty.resize(cols, rows)
    const [command, args] =
      this.platform === "win32"
        ? [findOnPath("pwsh.exe") ?? "powershell.exe", ["-NoLogo"]]
        : [process.env.SHELL || userInfo().shell || "/bin/sh", ["-l"]]
    this.#pty = this.spawnPty(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.cwd,
      env: { ...process.env, TERM_PROGRAM: "Otis" },
    })
    this.#pty.onData((data) => {
      this.#pending += data
      this.#history += data
      if (this.#history.length > HISTORY_LIMIT) {
        const start = this.#history.length - HISTORY_LIMIT
        const cut = this.#history.indexOf("\n", start)
        this.#history = this.#history.slice(cut === -1 ? start : cut + 1)
      }
      if (!this.#flush) this.#flush = setTimeout(() => this.#deliver(), FLUSH_INTERVAL_MS)
    })
    this.#pty.onExit(() => {
      this.#deliver()
      this.onExit()
    })
  }

  kill() {
    if (this.#pty) this.#pty.kill()
    else this.onExit()
  }

  #deliver() {
    clearTimeout(this.#flush)
    this.#flush = undefined
    if (!this.#pending) return
    this.send(this.#pending)
    this.#pending = ""
  }
}
