import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FEEDBACK_ADDRESS, feedbackEmail, openURL } from "../../src/cli/links.js"
import { HOSTED_PROVIDER_INFO, HOSTED_PROVIDERS } from "../../src/inference/types.js"
import { THIS_COMPUTER } from "../../src/local/paths.js"

const spawn = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({ spawn }))

const PLATFORM = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor
afterEach(() => {
  Object.defineProperty(process, "platform", PLATFORM)
  spawn.mockReset()
})

/** Runs on `platform`, where a launcher process starts or fails to. */
function on(platform: NodeJS.Platform, starts = true) {
  Object.defineProperty(process, "platform", { ...PLATFORM, value: platform })
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    queueMicrotask(() => child.emit(starts ? "spawn" : "error", new Error("ENOENT")))
    return child
  })
}

const DETACHED = { detached: true, stdio: "ignore", windowsHide: true }

describe("external links", () => {
  it.each(HOSTED_PROVIDERS)("opens the %s key page with the macOS launcher", async (provider) => {
    on("darwin")
    const url = HOSTED_PROVIDER_INFO[provider].keyURL
    await expect(openURL(url)).resolves.toBe(true)
    expect(spawn).toHaveBeenCalledWith("/usr/bin/open", [url], DETACHED)
  })

  it("opens a link with the Linux launcher", async () => {
    on("linux")
    const draft = feedbackEmail("1.0.0", "terminal")
    await expect(openURL(draft)).resolves.toBe(true)
    expect(spawn).toHaveBeenCalledWith("xdg-open", [draft], DETACHED)
  })

  it("opens a link through Windows' URL handler, with no shell in between", async () => {
    on("win32")
    const url = HOSTED_PROVIDER_INFO.baseten.keyURL
    await expect(openURL(url)).resolves.toBe(true)
    expect(spawn).toHaveBeenCalledWith(
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", url],
      DETACHED,
    )
  })

  it("keeps every provider's key page on that provider's own site", () => {
    expect(new URL(HOSTED_PROVIDER_INFO.fireworks.keyURL).hostname).toBe("app.fireworks.ai")
    expect(new URL(HOSTED_PROVIDER_INFO.together.keyURL).hostname).toBe("api.together.ai")
    expect(new URL(HOSTED_PROVIDER_INFO.baseten.keyURL).hostname).toBe("app.baseten.co")
    expect(new URL(HOSTED_PROVIDER_INFO.primeintellect.keyURL).hostname).toBe(
      "app.primeintellect.ai",
    )
  })

  it("reports false when there is no launcher or it fails to start", async () => {
    const url = HOSTED_PROVIDER_INFO.fireworks.keyURL
    on("freebsd")
    await expect(openURL(url)).resolves.toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    on("linux", false)
    await expect(openURL(url)).resolves.toBe(false)
  })

  it("drafts feedback with room to write, then the version, the app and this computer", () => {
    const draft = new URL(feedbackEmail("0.2.50", "desktop"))
    expect(draft.protocol).toBe("mailto:")
    expect(draft.pathname).toBe(FEEDBACK_ADDRESS)
    expect(draft.searchParams.get("subject")).toBe("Otis feedback")
    // Spaces stay %20 rather than "+", which email apps would show literally.
    expect(draft.search).not.toContain("+")
    const body = decodeURIComponent(/[?&]body=([^&]*)/.exec(draft.search)?.[1] ?? "")
    expect(body).toBe(
      `\r\n\r\n\r\nOtis 0.2.50 (desktop) · ${THIS_COMPUTER.os} on ${THIS_COMPUTER.arch}`,
    )
  })
})
