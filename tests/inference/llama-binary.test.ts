import { describe, expect, it } from "vitest"
import { assetNameFor, latestLlamaCppRelease, selectLlamaCppAsset } from "../../src/inference/llama-binary.js"

const release = {
  tag_name: "b10622",
  assets: [
    { name: "llama-b10622-bin-macos-arm64.tar.gz", browser_download_url: "https://example.test/mac", size: 10 },
    { name: "llama-b10622-bin-ubuntu-vulkan-x64.tar.gz", browser_download_url: "https://example.test/vk", size: 11 },
    { name: "llama-b10622-bin-ubuntu-x64.tar.gz", browser_download_url: "https://example.test/cpu", size: 12 },
  ],
}

describe("llama.cpp binary selection", () => {
  it("picks Metal, Vulkan, and CPU archives for the supported targets", () => {
    expect(assetNameFor("b10622", { platform: "darwin", arch: "arm64", backend: "metal" })).toBe(
      "llama-b10622-bin-macos-arm64.tar.gz",
    )
    expect(selectLlamaCppAsset(release, { platform: "linux", arch: "x64", backend: "vulkan" }).name).toBe(
      "llama-b10622-bin-ubuntu-vulkan-x64.tar.gz",
    )
    expect(selectLlamaCppAsset(release, { platform: "linux", arch: "x64", backend: "cpu" }).name).toBe(
      "llama-b10622-bin-ubuntu-x64.tar.gz",
    )
  })

  it("uses the newest b-release that actually has assets", () => {
    const chosen = latestLlamaCppRelease([
      {
        tag_name: "v0.3.0",
        assets: [{ name: "nightly-tag.txt", browser_download_url: "https://example.test/n", size: 1 }],
      },
      release,
    ])
    expect(chosen.tag_name).toBe("b10622")
  })
})
