import { describe, expect, it } from "vitest"
import { shellEnvironment } from "../../src/tools/shell.js"

describe("shellEnvironment", () => {
  it("does not expose provider credentials to child commands", () => {
    const source = {
      PATH: "/usr/bin",
      FIREWORKS_API_KEY: "fw_secret",
      PARALLEL_API_KEY: "parallel_secret",
    }

    expect(shellEnvironment(source)).toEqual({ PATH: "/usr/bin" })
    expect(source.FIREWORKS_API_KEY).toBe("fw_secret")
  })
})
