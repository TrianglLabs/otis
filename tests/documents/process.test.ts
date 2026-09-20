import { afterEach, describe, expect, it, vi } from "vitest"
import { runDocumentProcess } from "../../src/documents/process.js"

afterEach(() => vi.unstubAllEnvs())

describe("document subprocess", () => {
  it("passes literal arguments without a shell and excludes secrets and Python overrides", async () => {
    vi.stubEnv("FIREWORKS_API_KEY", "test-secret")
    vi.stubEnv("OMLX_API_KEY", "test-secret")
    vi.stubEnv("PYTHONPATH", "/untrusted/modules")
    vi.stubEnv("PIP_INDEX_URL", "https://user:secret@example.invalid")
    const result = await runDocumentProcess(
      process.execPath,
      [
        "-e",
        "console.log(JSON.stringify({args:process.argv.slice(1),env:process.env}))",
        "literal $(touch nope); text",
      ],
      { cwd: process.cwd() },
    )
    const value = JSON.parse(result)
    expect(value.args).toEqual(["literal $(touch nope); text"])
    expect(value.env.FIREWORKS_API_KEY).toBeUndefined()
    expect(value.env.OMLX_API_KEY).toBeUndefined()
    expect(value.env.PYTHONPATH).toBeUndefined()
    expect(value.env.PIP_INDEX_URL).toBeUndefined()
  })

  it("rejects process failures, excessive output and timeouts", async () => {
    await expect(
      runDocumentProcess(process.execPath, ["-e", "console.error('fixture failure');process.exit(1)"], {
        cwd: process.cwd(),
      }),
    ).rejects.toThrow("fixture failure")
    await expect(
      runDocumentProcess(process.execPath, ["-e", "console.log('x'.repeat(600000))"], { cwd: process.cwd() }),
    ).rejects.toThrow("too large")
    await expect(
      runDocumentProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: process.cwd(), timeoutMs: 30 }),
    ).rejects.toThrow("timed out")
  })

  it("cancels a running process", async () => {
    const controller = new AbortController()
    const promise = runDocumentProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      cwd: process.cwd(),
      signal: controller.signal,
    })
    const assertion = expect(promise).rejects.toThrow("cancelled")
    controller.abort()
    await assertion
  })
})
