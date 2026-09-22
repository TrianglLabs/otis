import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { childProcessEnvironment, llamaServerRecordPath } from "../../src/local/paths.js"

const originalHome = process.env.OTIS_HOME
afterEach(() => {
  if (originalHome === undefined) delete process.env.OTIS_HOME
  else process.env.OTIS_HOME = originalHome
})

describe("childProcessEnvironment", () => {
  it("does not expose provider credentials to child commands", () => {
    const source = {
      PATH: "/usr/bin",
      FIREWORKS_API_KEY: "fw_secret",
    }

    expect(childProcessEnvironment(source)).toEqual({ PATH: "/usr/bin" })
    expect(source.FIREWORKS_API_KEY).toBe("fw_secret")
  })
})

describe("llamaServerRecordPath", () => {
  it("lives beside the managed runtime and model caches", () => {
    process.env.OTIS_HOME = "/tmp/otis-home"
    expect(llamaServerRecordPath()).toBe(join("/tmp/otis-home", "llama", "server.json"))
  })
})
