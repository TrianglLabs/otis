import { randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { type WebSocket, WebSocketServer } from "ws"
import { describeError } from "../inference/errors.js"
import { localConfigDirectory } from "../local/paths.js"
import { type ClientMessage, decode, encode, MAX_FRAME, type ServerMessage } from "./wire.js"

/** The pairing token, created privately on first use and reused by every later listener. */
export async function serveToken() {
  const path = join(localConfigDirectory(), "serve-token")
  const saved = (await readFile(path, "utf8").catch(() => "")).trim()
  if (saved) return saved
  const token = randomBytes(32).toString("hex")
  await mkdir(localConfigDirectory(), { recursive: true, mode: 0o700 })
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  return token
}

/** A network this machine is on, by the IPv4 address a client would paste. */
export type Network = { address: string; via: string }

/**
 * This machine's addresses on private networks, the tailnet one named so it stands out from the
 * LAN (Tailscale hands out 100.64.0.0/10).
 */
export function privateNetworks(): Network[] {
  return Object.entries(networkInterfaces()).flatMap(([name, nets]) =>
    (nets ?? [])
      .filter((net) => net.family === "IPv4" && !net.internal)
      .map((net) => {
        const [a, b] = net.address.split(".").map(Number)
        return { address: net.address, via: a === 100 && b >= 64 && b < 128 ? "Tailscale" : name }
      }),
  )
}

/**
 * Desktop apps on other devices reach the runtime here: JSON frames over one WebSocket each,
 * admitted by the pairing token at the handshake, every call dispatched through `call` and every
 * event the runtime emits broadcast to all of them.
 */
export async function listenDesktop(options: {
  host: string
  port: number
  token: string
  call: (method: string, args: unknown[]) => unknown
}) {
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
        client.send(encode({ id, result: (await options.call(method, args)) ?? null }))
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
    broadcast(message: ServerMessage) {
      if (sockets.clients.size === 0) return
      const text = encode(message)
      for (const client of sockets.clients) client.send(text)
    },
    async close() {
      for (const client of sockets.clients) client.close(1001, "Otis is stopping.")
      // Upgraded sockets keep an HTTP server from closing on their own.
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
