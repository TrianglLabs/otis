import { describe, expect, it } from "vitest"
import {
  LLAMA_CPP_RELEASE_TAG,
  PRISM_LLAMA_CPP_RELEASE_TAG,
  pinnedLlamaCppAsset,
  supportsLlamaCppTarget,
} from "../../src/inference/llama-binary.js"

describe("llama.cpp binary selection", () => {
  it("builds deterministic asset URLs for the pinned release", () => {
    expect(LLAMA_CPP_RELEASE_TAG).toBe("b10666")
    expect(pinnedLlamaCppAsset({ platform: "darwin", arch: "arm64", backend: "metal" })).toEqual({
      name: "llama-b10666-bin-macos-arm64.tar.gz",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b10666/llama-b10666-bin-macos-arm64.tar.gz",
      size: 11_022_594,
      sha256: "f2b5d7b445cfcdab2abe53e0e6e697790094fb902ef2bdaafd23c813bb297cbb",
    })
    expect(pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "vulkan" }).name).toBe(
      "llama-b10666-bin-ubuntu-vulkan-x64.tar.gz",
    )
    expect(pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "cpu" }).name).toBe(
      "llama-b10666-bin-ubuntu-x64.tar.gz",
    )
  })

  it("pins Prism's llama.cpp fork for ternary models", () => {
    expect(PRISM_LLAMA_CPP_RELEASE_TAG).toBe("prism-b10685-7dffb15")
    expect(pinnedLlamaCppAsset({ platform: "darwin", arch: "arm64", backend: "metal" }, "prism")).toEqual({
      name: "llama-prism-b10685-7dffb15-bin-macos-arm64.tar.gz",
      url: "https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10685-7dffb15/llama-prism-b10685-7dffb15-bin-macos-arm64.tar.gz",
      size: 11_663_250,
      sha256: "7fffa7a40c74f3e9bd78f3f2f9f12f9befb7b13af45d5a69c239cf3fd37b9045",
    })
    expect(pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "vulkan" }, "prism")).toMatchObject({
      name: "llama-prism-b10685-7dffb15-bin-ubuntu-vulkan-x64.tar.gz",
      size: 34_218_725,
      sha256: "20aec2cce7e07b1df8a21a4bfef4b88db085210dac01b8a32374b5ed756f50e4",
    })
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
