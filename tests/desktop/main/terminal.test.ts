import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceTerminal } from "../../../src/desktop/main/terminal.js"
import { fakePty } from "../support/pty.js"

afterEach(() => vi.useRealTimers())

describe("WorkspaceTerminal", () => {
  it("runs the login shell in the workspace, ships a frame of output as one message, keeps it", () => {
    vi.useFakeTimers()
    vi.stubEnv("SHELL", "/bin/zsh")
    const shell = fakePty()
    const sent: string[] = []
    const onExit = vi.fn()
    const terminal = new WorkspaceTerminal(shell.spawn, "/work", (d) => sent.push(d), onExit)
    expect(shell.spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-l"],
      expect.objectContaining({ name: "xterm-256color", cols: 80, rows: 24, cwd: "/work" }),
    )
    shell.print("a")
    shell.print("b")
    expect(sent).toEqual([])
    vi.advanceTimersByTime(16)
    expect(sent).toEqual(["ab"])
    expect(terminal.history).toBe("ab")

    terminal.write("ls\r")
    terminal.resize(50, 10)
    expect(shell.pty.write).toHaveBeenCalledWith("ls\r")
    expect(shell.pty.resize).toHaveBeenCalledWith(50, 10)

    // What the shell printed on its way out lands before the exit report.
    shell.print("bye")
    shell.exit()
    expect(sent).toEqual(["ab", "bye"])
    expect(onExit).toHaveBeenCalledOnce()
    terminal.kill()
    expect(shell.pty.kill).toHaveBeenCalledOnce()
  })

  it("retains the last million characters, dropping the oldest whole lines first", () => {
    const shell = fakePty()
    const terminal = new WorkspaceTerminal(
      shell.spawn,
      "/work",
      () => {},
      () => {},
    )
    const line = (index: number) => `line ${index} ${"x".repeat(990)}\n`
    for (let index = 0; index < 1200; index += 1) shell.print(line(index))
    expect(terminal.history.length).toBeLessThanOrEqual(1_000_000)
    expect(terminal.history.startsWith("line ")).toBe(true)
    expect(terminal.history.endsWith(line(1199))).toBe(true)
  })
})
