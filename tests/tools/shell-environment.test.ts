import { describe, expect, it } from "vitest"
import { childProcessEnvironment } from "../../src/local/child-environment.js"

describe("childProcessEnvironment", () => {
  it("does not expose provider credentials to child commands", () => {
    const source = {
      PATH: "/usr/bin",
      FIREWORKS_API_KEY: "fw_secret",
      PARALLEL_API_KEY: "parallel_secret",
    }

    expect(childProcessEnvironment(source)).toEqual({ PATH: "/usr/bin" })
    expect(source.FIREWORKS_API_KEY).toBe("fw_secret")
  })
})
