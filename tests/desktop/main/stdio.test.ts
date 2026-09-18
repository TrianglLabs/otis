import { EventEmitter } from "node:events"
import { Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import { handleClosedOutput } from "../../../src/desktop/main/stdio.js"

describe("desktop output pipes", () => {
  it("survives asynchronous EPIPE when the harness closes its pipe", async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("pipe closed"), { code: "EPIPE" }))
      },
    })
    handleClosedOutput(output)
    const closed = new Promise<void>((resolve) => output.once("close", resolve))
    output.write("diagnostic message")
    await closed
    expect(output.destroyed).toBe(true)
    expect(output.errored).toMatchObject({ code: "EPIPE" })
    // Further console output to the disconnected stream must not destabilize the app either.
    expect(() => output.write("later diagnostic")).not.toThrow()
  })

  it("does not suppress other stream errors", () => {
    const output = new EventEmitter()
    handleClosedOutput(output)
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" })
    expect(() => output.emit("error", error)).toThrow(error)
    expect(() => output.emit("error", new Error("unexpected error"))).toThrow("unexpected error")
  })
})
