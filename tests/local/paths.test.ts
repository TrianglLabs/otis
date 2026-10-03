import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { childProcessEnvironment, llamaServerRecordsDirectory } from "../../src/local/paths.js"

const originalHome = process.env.OTIS_HOME
afterEach(() => {
  if (originalHome === undefined) delete process.env.OTIS_HOME
  else process.env.OTIS_HOME = originalHome
})

describe("childProcessEnvironment", () => {
  it("does not expose any hosted provider credential to child commands", () => {
    const source = {
      PATH: "/usr/bin",
      FIREWORKS_API_KEY: "fw_secret",
      TOGETHER_API_KEY: "tg_secret",
      BASETEN_API_KEY: "bt_secret",
      PRIME_API_KEY: "pi_secret",
      HF_TOKEN: "hf_token",
    }

    expect(childProcessEnvironment(source)).toEqual({ PATH: "/usr/bin", HF_TOKEN: "hf_token" })
    expect(source).toMatchObject({
      FIREWORKS_API_KEY: "fw_secret",
      TOGETHER_API_KEY: "tg_secret",
      BASETEN_API_KEY: "bt_secret",
      PRIME_API_KEY: "pi_secret",
    })
  })
})

describe("llamaServerRecordsDirectory", () => {
  it("lives beside the managed runtime and model caches", () => {
    process.env.OTIS_HOME = "/tmp/otis-home"
    expect(llamaServerRecordsDirectory()).toBe(join("/tmp/otis-home", "llama", "servers"))
  })
})
