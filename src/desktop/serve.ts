import { timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { type WebSocket, WebSocketServer } from "ws"
import { describeError } from "../inference/errors.js"
import { desktopCall } from "./main/api.js"
import { DesktopRuntime } from "./main/runtime.js"
import { type ClientMessage, decode, encode, MAX_FRAME, type ServerMessage } from "./wire.js"

/**
 * The desktop runtime as a daemon: `otis serve` hosts it on this machine, and desktop apps connect
 * over a private network with the pairing token. Every client sees the same sessions, Canvas and
 * settings, because there is one runtime; a client that drops leaves the work running.
 */
export async function serveDesktop(options: {
  cwd: string
  host: string
  port: number
  version: string
  token: string
}) {
  const broadcast = (message: ServerMessage) => {
    if (sockets.clients.size === 0) return
    const text = encode(message)
    for (const client of sockets.clients) client.send(text)
  }
  const runtime = await DesktopRuntime.create({
    cwd: options.cwd,
    version: options.version,
    platform: process.platform,
    send: (event) => broadcast({ event }),
    sendTerminal: (data) => broadcast({ terminal: data }),
    notify: (notice) => broadcast({ notify: notice }),
    spawnPty: () => {
      throw new Error("The terminal is not available over a remote connection.")
    },
  })
  const call = desktopCall(runtime)
  const expected = Buffer.from(options.token)
  const paired = (token: unknown) => {
    const presented = Buffer.from(typeof token === "string" ? token : "")
    return presented.length === expected.length && timingSafeEqual(presented, expected)
  }
  const server = createServer((_request, response) => {
    response.writeHead(426, { "content-type": "text/plain" }).end("Otis serves WebSockets here.")
  })
  // The token rides the upgrade request, so a socket that is not paired never becomes one.
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })
  server.on("upgrade", (request, socket, head) => {
    if (!paired(request.headers.authorization?.replace(/^Bearer /, ""))) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n")
      return
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client))
  })
  sockets.on("connection", (client: WebSocket) => {
    client.on("message", async (raw) => {
      let message: ClientMessage
      try {
        message = decode(raw.toString()) as ClientMessage
      } catch {
        client.close(1003, "Otis expects JSON frames.")
        return
      }
      // JSON has no undefined: an omitted optional argument arrives as null, and no desktop
      // method takes null, so every null is the omission it came from.
      const { id, method } = message
      const args = (message.args ?? []).map((arg) => arg ?? undefined)
      try {
        client.send(encode({ id, result: (await call(method, args)) ?? null }))
      } catch (error) {
        client.send(encode({ id, error: describeError(error) }))
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.host, resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    port,
    url: `ws://${options.host}:${port}`,
    async close() {
      for (const client of sockets.clients) client.close(1001, "Otis is stopping.")
      // Upgraded sockets keep an HTTP server from closing on their own.
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await runtime.shutdown()
    },
  }
}
