import { describe, expect, it } from "vitest"
import { LLAMA_CPP_RELEASE_TAG, pinnedLlamaCppAsset, supportsLlamaCppTarget } from "../../src/inference/llama-binary.js"

describe("llama.cpp binary selection", () => {
  it("builds deterministic asset URLs for the pinned release", () => {
    expect(LLAMA_CPP_RELEASE_TAG).toBe("b10622")
    expect(pinnedLlamaCppAsset({ platform: "darwin", arch: "arm64", backend: "metal" })).toEqual({
      name: "llama-b10622-bin-macos-arm64.tar.gz",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b10622/llama-b10622-bin-macos-arm64.tar.gz",
      size: 10_954_906,
      sha256: "c0116ec9957477a9c77e68d3cf31e79f9aede1a9210861c7c09d74acc3e9c3cf",
    })
    expect(pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "vulkan" }).name).toBe(
      "llama-b10622-bin-ubuntu-vulkan-x64.tar.gz",
    )
    expect(pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "cpu" }).name).toBe(
      "llama-b10622-bin-ubuntu-x64.tar.gz",
    )
  })

  it("rejects unsupported platforms before a model is selected", () => {
    expect(supportsLlamaCppTarget({ platform: "linux", arch: "x64" })).toBe(true)
    expect(supportsLlamaCppTarget({ platform: "darwin", arch: "arm64" })).toBe(true)
    expect(supportsLlamaCppTarget({ platform: "win32", arch: "x64" })).toBe(false)
    expect(() => pinnedLlamaCppAsset({ platform: "win32", arch: "x64", backend: "cpu" })).toThrow(
      "Local inference is not supported on win32/x64.",
    )
  })
})
