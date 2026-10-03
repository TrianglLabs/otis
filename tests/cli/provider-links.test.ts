import { describe, expect, it, vi } from "vitest"
import { openHostedKeyPage } from "../../src/cli/provider-links.js"
import { HOSTED_PROVIDER_INFO, HOSTED_PROVIDERS } from "../../src/inference/types.js"

describe("provider key links", () => {
  it.each(HOSTED_PROVIDERS)("opens the %s key page with the macOS browser launcher", async (p) => {
    const launch = vi.fn(async () => undefined)

    await expect(openHostedKeyPage(p, { platform: "darwin", launch })).resolves.toBe(true)
    expect(launch).toHaveBeenCalledWith("/usr/bin/open", [HOSTED_PROVIDER_INFO[p].keyURL])
  })

  it("opens the key page with the Linux browser launcher", async () => {
    const launch = vi.fn(async () => undefined)

    await expect(openHostedKeyPage("together", { platform: "linux", launch })).resolves.toBe(true)
    expect(launch).toHaveBeenCalledWith("xdg-open", [HOSTED_PROVIDER_INFO.together.keyURL])
  })

  it("keeps every provider's key page on that provider's own site", () => {
    expect(new URL(HOSTED_PROVIDER_INFO.fireworks.keyURL).hostname).toBe("app.fireworks.ai")
    expect(new URL(HOSTED_PROVIDER_INFO.together.keyURL).hostname).toBe("api.together.ai")
    expect(new URL(HOSTED_PROVIDER_INFO.baseten.keyURL).hostname).toBe("app.baseten.co")
    expect(new URL(HOSTED_PROVIDER_INFO.primeintellect.keyURL).hostname).toBe(
      "app.primeintellect.ai",
    )
  })

  it("does not block setup when no browser launcher is available or launch fails", async () => {
    const failedLaunch = vi.fn(async () => {
      throw new Error("headless")
    })

    await expect(
      openHostedKeyPage("fireworks", { platform: "freebsd", launch: failedLaunch }),
    ).resolves.toBe(false)
    expect(failedLaunch).not.toHaveBeenCalled()
    await expect(
      openHostedKeyPage("baseten", { platform: "linux", launch: failedLaunch }),
    ).resolves.toBe(false)
  })
})
