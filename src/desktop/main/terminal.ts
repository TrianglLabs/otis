import { userInfo } from "node:os"
import type { IPty, spawn } from "node-pty"

export type SpawnPty = typeof spawn

const FLUSH_INTERVAL_MS = 16
/** Retained output, in characters; the oldest whole lines go first once it is exceeded. */
const HISTORY_LIMIT = 1_000_000
/** The grid until the renderer reports its own. */
const COLS = 80
const ROWS = 24

/**
 * The workspace's login shell behind a pseudo-terminal. Output is coalesced per frame before it
 * crosses to the renderer, so a build's stream of small writes does not become a stream of IPC
 * messages, and retained so a renderer that comes back, or comes later, can replay it.
 */
export class WorkspaceTerminal {
  readonly #pty: IPty
  #pending = ""
  #flush: ReturnType<typeof setTimeout> | undefined
  #history = ""

  constructor(
    spawnPty: SpawnPty,
    cwd: string,
    private readonly send: (data: string) => void,
    onExit: () => void,
  ) {
    this.#pty = spawnPty(process.env.SHELL || userInfo().shell || "/bin/sh", ["-l"], {
      name: "xterm-256color",
      cols: COLS,
      rows: ROWS,
      cwd,
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
      onExit()
    })
  }

  get history() {
    return this.#history
  }

  write(data: string) {
    this.#pty.write(data)
  }

  resize(cols: number, rows: number) {
    this.#pty.resize(cols, rows)
  }

  kill() {
    this.#pty.kill()
  }

  #deliver() {
    clearTimeout(this.#flush)
    this.#flush = undefined
    if (!this.#pending) return
    this.send(this.#pending)
    this.#pending = ""
  }
}
