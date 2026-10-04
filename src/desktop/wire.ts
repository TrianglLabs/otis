import type { DesktopEvent } from "./contracts.js"

/**
 * What crosses between a desktop client and `otis serve`: JSON text frames over one WebSocket. The
 * client calls API methods by name; the server answers by id and pushes the same event, terminal
 * and notification streams the in-process runtime hands the window.
 */
export const SERVE_PORT = 7331
/** The largest frame either end accepts: a document's bytes as base64, with room to spare. */
export const MAX_FRAME = 256 * 1024 * 1024

export type SessionNotice = { runtime: number; title: string; failed: boolean }

export type ClientMessage = { id: number; method: string; args: unknown[] }

export type ServerMessage =
  | { id: number; result: unknown }
  | { id: number; error: string }
  | { event: DesktopEvent }
  | { terminal: string }
  | { notify: SessionNotice }

/**
 * Bytes (attachments, PDF payloads, exports) ride as base64 inside the JSON. Both directions wrap
 * the existing memory rather than copying it: a document's bytes exist once on each side.
 */
export function encode(message: unknown) {
  return JSON.stringify(message, (_key, value) =>
    value instanceof Uint8Array
      ? { $bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") }
      : value,
  )
}

export function decode(text: string): unknown {
  return JSON.parse(text, (_key, value) => {
    if (!value || typeof value !== "object" || typeof value.$bytes !== "string") return value
    // Written into an allocation of its own, so a small payload is never a view over the pool
    // that other buffers share.
    const bytes = new Uint8Array(Buffer.byteLength(value.$bytes, "base64"))
    Buffer.from(bytes.buffer).write(value.$bytes, "base64")
    return bytes
  })
}
