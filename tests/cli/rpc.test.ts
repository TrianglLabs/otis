import { spawn } from "node:child_process"
import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { describe, expect, it } from "vitest"
import { useOtisHome } from "../app/support/otis-home.js"

const otisHome = useOtisHome()

/** `otis rpc` as the terminal UI runs it: frames on stdin, answers and events on stdout. */
async function rpc() {
  const home = await otisHome("otis-rpc-")
  const cwd = join(home, "workspace")
  await mkdir(cwd, { recursive: true })
  const child = spawn(process.execPath, [join(process.cwd(), "src/cli/index.ts"), "rpc"], {
    cwd,
    env: { ...process.env, OTIS_HOME: home, XDG_STATE_HOME: home, OTIS_VERSION: "9.9.9" },
    stdio: ["pipe", "pipe", "ignore"],
  })
  const replies = new Map<number, (frame: Record<string, unknown>) => void>()
  const frames: Record<string, unknown>[] = []
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line) as Record<string, unknown>
    frames.push(frame)
    if (typeof frame.id === "number") replies.get(frame.id)?.(frame)
  })
  let next = 0
  const call = (method: string, args: unknown[] = []) => {
    const id = ++next
    const reply = new Promise<Record<string, unknown>>((resolve) => replies.set(id, resolve))
    child.stdin.write(`${JSON.stringify({ id, method, args })}\n`)
    return reply
  }
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
  return { call, frames, exited, cwd, close: () => child.stdin.end() }
}

describe("otis rpc", () => {
  it("serves the desktop API for its folder by id, and stops when its client closes stdin", async () => {
    const { call, exited, cwd, close } = await rpc()
    const { result } = await call("getSnapshot")
    const snapshot = result as Record<string, unknown>
    expect(snapshot.version).toBe("9.9.9")
    expect(snapshot.modelState).toBe("unconfigured")
    expect(await realpath((snapshot.workspace as { path: string }).path)).toBe(await realpath(cwd))
    close()
    expect(await exited).toBe(0)
  }, 20_000)

  it("answers a failing call by its id and keeps serving", async () => {
    const { call, exited, close } = await rpc()
    const [refused, unknown] = await Promise.all([call("setTheme", [42]), call("noSuchMethod")])
    expect(refused).toEqual({ id: 1, error: "Invalid theme." })
    expect(unknown).toEqual({ id: 2, error: "Unknown desktop method: noSuchMethod" })
    expect((await call("setDebugMode", [true])).result).toBeNull()
    close()
    expect(await exited).toBe(0)
  }, 20_000)

  it("streams the runtime's events between the answers", async () => {
    const { call, frames, exited, close } = await rpc()
    await call("getSnapshot")
    await call("setDebugMode", [true])
    const debug = (frame: Record<string, unknown>) =>
      (frame.event as { status?: { debug?: boolean } } | undefined)?.status?.debug
    await expect.poll(() => frames.some((frame) => debug(frame) === true)).toBe(true)
    close()
    expect(await exited).toBe(0)
  }, 20_000)
})
