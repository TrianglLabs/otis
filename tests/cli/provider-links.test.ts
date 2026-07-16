import { describe, expect, it, vi } from "vitest"
import { openProviderKeyPage, PROVIDER_KEY_URLS } from "../../src/cli/provider-links.js"

describe("provider key links", () => {
  it("opens the official Fireworks key page with the macOS browser launcher", async () => {
    const launch = vi.fn(async () => undefined)

    await expect(openProviderKeyPage("fireworks", { platform: "darwin", launch })).resolves.toBe(true)
    expect(launch).toHaveBeenCalledWith("/usr/bin/open", [PROVIDER_KEY_URLS.fireworks])
  })

  it("opens the official Parallel platform with the Linux browser launcher", async () => {
    const launch = vi.fn(async () => undefined)

    await expect(openProviderKeyPage("parallel", { platform: "linux", launch })).resolves.toBe(true)
    expect(launch).toHaveBeenCalledWith("xdg-open", [PROVIDER_KEY_URLS.parallel])
  })

  it("does not block setup when no browser launcher is available or launch fails", async () => {
    const failedLaunch = vi.fn(async () => {
      throw new Error("headless")
    })

    await expect(openProviderKeyPage("fireworks", { platform: "freebsd", launch: failedLaunch })).resolves.toBe(false)
    expect(failedLaunch).not.toHaveBeenCalled()
    await expect(openProviderKeyPage("fireworks", { platform: "linux", launch: failedLaunch })).resolves.toBe(false)
  })
})
