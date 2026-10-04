import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import type { DesktopEvent, DesktopSnapshot } from "../../src/desktop/contracts.js"
import { connectRemote } from "../../src/desktop/main/remote.js"
import { serveDesktop } from "../../src/desktop/serve.js"
import { loadLocalSettings, saveSelectedTheme } from "../../src/local/settings.js"
import { useOtisHome } from "../app/support/otis-home.js"

const otisHome = useOtisHome()
const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()))
})

async function serve() {
  const home = await otisHome("otis-serve-")
  const cwd = join(home, "workspace")
  await mkdir(cwd, { recursive: true })
  const server = await serveDesktop({
    cwd,
    host: "127.0.0.1",
    port: 0,
    version: "daemon-test",
    token: "secret-token",
  })
  open.push(server)
  return { server, cwd, home }
}

function client(url: string, token: string, onEvent = (_event: DesktopEvent) => {}) {
  return connectRemote(
    { url, token },
    {
      platform: "linux",
      version: "client-test",
      onEvent,
      onTerminal: () => {},
      onNotify: () => {},
      onClose: () => {},
      checkForUpdates: async () => {},
      installUpdate: async () => {},
    },
  )
}

describe("otis serve", () => {
  it("admits only the pairing token, at the handshake, with no lost-connection notice", async () => {
    const { server } = await serve()
    const onClose = vi.fn()
    // Bun's ws shim reports the 401 only as a failed connection; Node names the status.
    await expect(
      connectRemote(
        { url: server.url, token: "wrong" },
        {
          platform: "linux",
          version: "client-test",
          onEvent: () => {},
          onTerminal: () => {},
          onNotify: () => {},
          onClose,
          checkForUpdates: async () => {},
          installUpdate: async () => {},
        },
      ),
    ).rejects.toThrow(/rejected the pairing token|Couldn't reach/)
    expect(onClose).not.toHaveBeenCalled()
    const backend = await client(server.url, "secret-token")
    await backend.shutdown()
  })

  it("drops a paired peer that sends garbage and keeps serving everyone else", async () => {
    const { server } = await serve()
    const backend = await client(server.url, "secret-token")
    const peer = new WebSocket(server.url, { headers: { authorization: "Bearer secret-token" } })
    const closed = new Promise<number>((resolve) => peer.on("close", resolve))
    await new Promise<void>((resolve) => peer.on("open", () => resolve()))
    peer.send("not json")
    expect(await closed).toBe(1003)
    expect(await backend.call("getSnapshot", [])).toMatchObject({ busy: false })
    await backend.shutdown()
  })

  it("answers every call made after the daemon went away instead of hanging", async () => {
    const { server } = await serve()
    const onClose = vi.fn()
    const backend = await connectRemote(
      { url: server.url, token: "secret-token" },
      {
        platform: "linux",
        version: "client-test",
        onEvent: () => {},
        onTerminal: () => {},
        onNotify: () => {},
        onClose,
        checkForUpdates: async () => {},
        installUpdate: async () => {},
      },
    )
    await backend.call("getSnapshot", [])
    await server.close()
    open.pop()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    await expect(backend.call("getSnapshot", [])).rejects.toThrow("Lost the connection")
  })

  it("serves the runtime by method name, with this client's platform and version", async () => {
    const { server, cwd } = await serve()
    const backend = await client(server.url, "secret-token")
    const snapshot = (await backend.call("getSnapshot", [])) as DesktopSnapshot
    expect(snapshot.workspace.path).toBe(cwd)
    expect(snapshot.remote).toBe(new URL(server.url).host)
    expect(snapshot.platform).toBe("linux")
    expect(snapshot.version).toBe("client-test")
    // Validation runs where the runtime lives, and a failure comes back as its sentence.
    await expect(backend.call("setPrimeTeamId", [42])).rejects.toThrow("Invalid team id.")
    await expect(backend.call("nope", [])).rejects.toThrow("Unknown desktop method: nope")
    await expect(backend.call("openTerminal", [])).rejects.toThrow("not available over a remote")
    // Omitted optional arguments survive the wire; the runtime, not the validator, answers.
    await expect(backend.call("selectSession", ["missing", undefined])).resolves.toHaveProperty(
      "ok",
    )
    const reference = { source: "workspace", path: "notes.md", kind: "markdown" }
    await expect(backend.call("openArtifact", [reference])).resolves.toHaveProperty("ok")
    // Bytes cross the wire intact: the attachment check passes and the runtime answers.
    const bytes = new Uint8Array([1, 2, 3])
    const sent = await backend.call("sendPrompt", [
      "hi",
      [{ name: "notes.txt", mimeType: "text/plain", bytes }],
    ])
    expect(sent).toMatchObject({ accepted: false })
    await backend.shutdown()
  })

  it("keeps appearance on the client and forwards everything else, streaming status back", async () => {
    const { server } = await serve()
    const events: DesktopEvent[] = []
    const backend = await client(server.url, "secret-token", (event) => events.push(event))
    const before = (await backend.call("getSnapshot", [])) as DesktopSnapshot
    await backend.call("setTheme", ["pearl"])
    // Saved in this machine's settings, shown in the next status, never sent to the daemon.
    expect((await loadLocalSettings()).theme).toBe("pearl")
    const restated = events.at(-1)
    expect(restated).toMatchObject({ type: "status", status: { theme: "pearl" } })
    expect(restated?.revision).toBeGreaterThan(before.revision)
    // A daemon-side change streams back with a revision above the restated one.
    await saveSelectedTheme("default")
    await backend.call("setDebugMode", [true])
    await vi.waitFor(() => {
      const status = events.findLast((event) => event.type === "status")
      expect(status).toMatchObject({ status: { debug: true, theme: "pearl" } })
      expect(status?.revision).toBeGreaterThan(restated?.revision ?? 0)
    })
    await backend.shutdown()
  })

  it("leaves the daemon's work running when the client goes away", async () => {
    const { server } = await serve()
    const events: DesktopEvent[] = []
    const backend = await client(server.url, "secret-token", (event) => events.push(event))
    await backend.shutdown()
    const again = await client(server.url, "secret-token")
    const snapshot = (await again.call("getSnapshot", [])) as DesktopSnapshot
    expect(snapshot.session).toBeNull()
    expect(snapshot.busy).toBe(false)
    await again.shutdown()
  })

  it("writes a private pairing token once and reuses it", async () => {
    const { home } = await serve()
    const { serveToken } = await import("../../src/cli/serve.js")
    const token = await serveToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(await serveToken()).toBe(token)
    const path = join(home, "serve-token")
    expect((await readFile(path, "utf8")).trim()).toBe(token)
  })
})
