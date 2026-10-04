import { describe, expect, it } from "vitest"
import { decode, encode } from "../../src/desktop/wire.js"

describe("wire codec", () => {
  it("carries bytes through JSON and restores them as Uint8Array, wherever they sit", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    const message = {
      id: 3,
      method: "sendPrompt",
      args: ["hi", [{ name: "a.pdf", mimeType: "application/pdf", bytes }]],
      nested: { payload: { encoding: "bytes", content: bytes }, plain: "$bytes" },
    }
    const text = encode(message)
    expect(text).not.toContain("255")
    const decoded = decode(text) as typeof message
    expect(decoded.args[1]).toEqual([{ name: "a.pdf", mimeType: "application/pdf", bytes }])
    expect(decoded.args[1]).toBeInstanceOf(Array)
    expect((decoded.args[1] as { bytes: unknown }[])[0]?.bytes).toBeInstanceOf(Uint8Array)
    expect(decoded.nested.payload.content).toEqual(bytes)
    expect(decoded.nested.plain).toBe("$bytes")
    expect(decode(encode({ id: 1, result: null }))).toEqual({ id: 1, result: null })
  })
})
