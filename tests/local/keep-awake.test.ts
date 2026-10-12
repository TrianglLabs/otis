import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { holdAwake } from "../../src/local/keep-awake.js"

const spawned = vi.hoisted(() => [] as { command: string; args: string[]; options: unknown }[])
const children = vi.hoisted(() => [] as FakeChild[])

type FakeChild = EventEmitter & { pid?: number; exitCode: number | null; unref: () => void }

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: unknown) => {
    spawned.push({ command, args, options })
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null,
      unref: vi.fn(),
    }) as FakeChild
    children.push(child)
    return child
  },
}))

afterEach(() => {
  spawned.length = 0
  children.length = 0
  vi.restoreAllMocks()
})

describe("holdAwake", () => {
  it("runs caffeinate on macOS against idle sleep only, watching this process", () => {
    holdAwake("darwin", 77)
    expect(spawned).toEqual([
      {
        command: "caffeinate",
        args: ["-i", "-w", "77"],
        options: { detached: true, stdio: "ignore" },
      },
    ])
    expect(children[0].unref).toHaveBeenCalled()
  })

  it("takes a systemd sleep inhibitor on Linux that ends with this process", () => {
    holdAwake("linux", 77)
    expect(spawned[0].command).toBe("systemd-inhibit")
    expect(spawned[0].args).toEqual([
      "--what=sleep",
      "--mode=block",
      "--who=Otis",
      "--why=Otis is working",
      "tail",
      "--pid=77",
      "-f",
      "/dev/null",
    ])
  })

  it("does nothing on a platform without a helper", () => {
    expect(holdAwake("win32", 77)).toBeUndefined()
    expect(spawned).toEqual([])
  })

  it("releases by ending the helper's process group, once", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    const release = holdAwake("darwin", 77)
    release?.()
    expect(kill).toHaveBeenCalledWith(-4242)
    children[0].exitCode = 0
    release?.()
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it("survives a missing helper and a helper that already exited", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
    })
    const release = holdAwake("linux", 77)
    expect(() => children[0].emit("error", new Error("spawn systemd-inhibit ENOENT"))).not.toThrow()
    expect(() => release?.()).not.toThrow()
    expect(kill).toHaveBeenCalled()
  })
})
