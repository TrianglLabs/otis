import { describe, expect, it } from "vitest"
import {
  llamaRuntimeReleaseTag,
  pinnedLlamaCppAsset,
  supportsLlamaCppTarget,
} from "../../src/inference/llama-binary.js"

describe("llama.cpp binary selection", () => {
  it("builds deterministic asset URLs for the pinned release", () => {
    expect(llamaRuntimeReleaseTag()).toBe("b12776")
    expect(pinnedLlamaCppAsset({ platform: "darwin", arch: "arm64", backend: "metal" })).toEqual({
      name: "llama-b12776-bin-macos-arm64.tar.gz",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b12776/llama-b12776-bin-macos-arm64.tar.gz",
      size: 16_889_708,
      sha256: "cb0c5c97a1a4ad50a0d64e228a67694de5c3a876d1ae0077b39e3c2381f3a039",
    })
    expect(pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "vulkan" }).name).toBe(
      "llama-b12776-bin-ubuntu-vulkan-x64.tar.gz",
    )
    expect(pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "cpu" }).name).toBe(
      "llama-b12776-bin-ubuntu-x64.tar.gz",
    )
  })

  it.each([
    ["x64", "12.8", "b12776"],
    ["x64", "13.5", "b12776"],
    ["arm64", "13.5", "b12776"],
    // R615 drivers keep the last 13.4 release, since 13.5 needs R620.
    ["x64", "13.4", "b11438"],
    ["arm64", "13.4", "b11438"],
  ] as const)("pairs Linux %s CUDA %s with the matching official runtime libraries from %s", (arch, cudaVersion, tag) => {
    const asset = pinnedLlamaCppAsset({ platform: "linux", arch, backend: "cuda", cudaVersion })
    expect(llamaRuntimeReleaseTag(cudaVersion)).toBe(tag)
    expect(asset.name).toBe(`llama-${tag}-bin-ubuntu-cuda-${cudaVersion}-${arch}.tar.gz`)
    expect(asset.url).toBe(
      `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${asset.name}`,
    )
    expect(asset.companion?.name).toBe(`cudart-${asset.name}`)
    expect(asset.companion?.url).toBe(
      `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/cudart-${asset.name}`,
    )
    expect(asset.companion?.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it("rejects incomplete CUDA targets instead of silently selecting Vulkan", () => {
    expect(() => pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "cuda" })).toThrow(
      "compatible Linux or Windows target",
    )
    expect(() =>
      pinnedLlamaCppAsset({
        platform: "linux",
        arch: "arm64",
        backend: "cuda",
        cudaVersion: "12.8",
      }),
    ).toThrow("No llama.cpp asset is pinned for linux/arm64.")
  })

  it("rejects unsupported platforms before a model is selected", () => {
    expect(supportsLlamaCppTarget({ platform: "linux", arch: "x64" })).toBe(true)
    expect(supportsLlamaCppTarget({ platform: "darwin", arch: "arm64" })).toBe(true)
    expect(supportsLlamaCppTarget({ platform: "win32", arch: "x64" })).toBe(true)
    expect(supportsLlamaCppTarget({ platform: "freebsd", arch: "x64" })).toBe(false)
    expect(() => pinnedLlamaCppAsset({ platform: "freebsd", arch: "x64", backend: "cpu" })).toThrow(
      "Local inference is not supported on freebsd/x64.",
    )
  })
})

describe("Windows llama.cpp assets", () => {
  it("pins the zip builds for CPU, Vulkan, and CUDA with NVIDIA's libraries beside them", () => {
    expect(pinnedLlamaCppAsset({ platform: "win32", arch: "x64", backend: "cpu" })).toEqual({
      name: "llama-b12776-bin-win-cpu-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b12776/llama-b12776-bin-win-cpu-x64.zip",
      size: 25_287_912,
      sha256: "bba23437a597b7b346acb87dbac2e5452c7b188cec67ca6315bec513a067ace8",
    })
    expect(pinnedLlamaCppAsset({ platform: "win32", arch: "arm64", backend: "vulkan" }).name).toBe(
      "llama-b12776-bin-win-vulkan-arm64.zip",
    )
    for (const [arch, cudaVersion, tag] of [
      ["x64", "12.4", "b12776"],
      ["x64", "13.5", "b12776"],
      ["arm64", "13.5", "b12776"],
      ["x64", "13.4", "b11438"],
      ["arm64", "13.4", "b11438"],
    ] as const) {
      const asset = pinnedLlamaCppAsset({ platform: "win32", arch, backend: "cuda", cudaVersion })
      expect(asset.name).toBe(`llama-${tag}-bin-win-cuda-${cudaVersion}-${arch}.zip`)
      expect(asset.companion?.name).toBe(`cudart-llama-bin-win-cuda-${cudaVersion}-${arch}.zip`)
      expect(asset.companion?.url).toBe(
        `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${asset.companion?.name}`,
      )
    }
  })

  it("has no CUDA build for macOS", () => {
    expect(() =>
      pinnedLlamaCppAsset({
        platform: "darwin",
        arch: "x64",
        backend: "cuda",
        cudaVersion: "12.4",
      }),
    ).toThrow("compatible Linux or Windows target")
  })
})
