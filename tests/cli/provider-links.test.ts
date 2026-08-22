import { describe, expect, it, vi } from "vitest"
import { FIREWORKS_KEY_URL, openFireworksKeyPage } from "../../src/cli/provider-links.js"

describe("provider key links", () => {
  it("opens the official Fireworks key page with the macOS browser launcher", async () => {
    const launch = vi.fn(async () => undefined)

    await expect(openFireworksKeyPage({ platform: "darwin", launch })).resolves.toBe(true)
    expect(launch).toHaveBeenCalledWith("/usr/bin/open", [FIREWORKS_KEY_URL])
  })

  it("opens the official Fireworks key page with the Linux browser launcher", async () => {
    const launch = vi.fn(async () => undefined)

    await expect(openFireworksKeyPage({ platform: "linux", launch })).resolves.toBe(true)
    expect(launch).toHaveBeenCalledWith("xdg-open", [FIREWORKS_KEY_URL])
  })

  it("does not block setup when no browser launcher is available or launch fails", async () => {
    const failedLaunch = vi.fn(async () => {
      throw new Error("headless")
    })

    await expect(openFireworksKeyPage({ platform: "freebsd", launch: failedLaunch })).resolves.toBe(false)
    expect(failedLaunch).not.toHaveBeenCalled()
    await expect(openFireworksKeyPage({ platform: "linux", launch: failedLaunch })).resolves.toBe(false)
  })
})
