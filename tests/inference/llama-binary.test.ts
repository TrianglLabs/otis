import { describe, expect, it } from "vitest"
import {
  type LlamaRuntimeKind,
  llamaRuntimeTarget,
  pinnedLlamaCppAsset,
  supportsLlamaCppTarget,
} from "../../src/inference/llama-binary.js"

/** The pinned release tags, read from the asset table's download URLs. */
const releaseTagOf = (runtime: LlamaRuntimeKind) =>
  pinnedLlamaCppAsset({ platform: "darwin", arch: "arm64", backend: "metal" }, runtime)
    .url.split("/")
    .at(-2)
const LLAMA_CPP_RELEASE_TAG = releaseTagOf("upstream")
const PRISM_LLAMA_CPP_RELEASE_TAG = releaseTagOf("prism")

describe("llama.cpp binary selection", () => {
  it("builds deterministic asset URLs for the pinned release", () => {
    expect(LLAMA_CPP_RELEASE_TAG).toBe("b11438")
    expect(pinnedLlamaCppAsset({ platform: "darwin", arch: "arm64", backend: "metal" })).toEqual({
      name: "llama-b11438-bin-macos-arm64.tar.gz",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b11438/llama-b11438-bin-macos-arm64.tar.gz",
      size: 11_971_002,
      sha256: "a19734f6cbfc011661ce517173bf3ccdb43d1e054038f73f44c1f9d8c2789132",
    })
    expect(pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "vulkan" }).name).toBe(
      "llama-b11438-bin-ubuntu-vulkan-x64.tar.gz",
    )
    expect(pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "cpu" }).name).toBe(
      "llama-b11438-bin-ubuntu-x64.tar.gz",
    )
  })

  it.each([
    ["x64", "12.8"],
    ["x64", "13.4"],
    ["arm64", "13.4"],
  ] as const)("pairs Linux %s CUDA %s with the matching official runtime libraries", (arch, cudaVersion) => {
    const asset = pinnedLlamaCppAsset({ platform: "linux", arch, backend: "cuda", cudaVersion })
    expect(asset.name).toBe(
      `llama-${LLAMA_CPP_RELEASE_TAG}-bin-ubuntu-cuda-${cudaVersion}-${arch}.tar.gz`,
    )
    expect(asset.companion?.name).toBe(`cudart-${asset.name}`)
    expect(asset.companion?.url).toBe(
      `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_RELEASE_TAG}/cudart-${asset.name}`,
    )
    expect(asset.companion?.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it("rejects incomplete CUDA targets instead of silently selecting Vulkan", () => {
    expect(() => pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "cuda" })).toThrow(
      "compatible Linux target",
    )
    expect(() =>
      pinnedLlamaCppAsset({
        platform: "linux",
        arch: "arm64",
        backend: "cuda",
        cudaVersion: "12.8",
      }),
    ).toThrow("No upstream llama.cpp asset")
  })

  it("pairs Prism CUDA 12.8 with the same NVIDIA libraries as upstream", () => {
    const hardware = {
      platform: "linux",
      arch: "x64",
      backend: "cuda",
      cudaVersion: "12.8",
    } as const
    const asset = pinnedLlamaCppAsset(hardware, "prism")
    expect(llamaRuntimeTarget(hardware, "prism")).toEqual(hardware)
    expect(asset.name).toBe(`llama-${PRISM_LLAMA_CPP_RELEASE_TAG}-bin-linux-cuda-12.8-x64.tar.gz`)
    expect(asset.url).toBe(
      `https://github.com/PrismML-Eng/llama.cpp/releases/download/${PRISM_LLAMA_CPP_RELEASE_TAG}/${asset.name}`,
    )
    expect(asset.companion).toEqual(pinnedLlamaCppAsset(hardware, "upstream").companion)
  })

  it("runs Prism's 13.3 build on a CUDA 13.4 machine, with the last 13.3 companion", () => {
    const hardware = {
      platform: "linux",
      arch: "x64",
      backend: "cuda",
      cudaVersion: "13.4",
    } as const
    expect(llamaRuntimeTarget(hardware, "prism")).toEqual({ ...hardware, cudaVersion: "13.3" })
    const asset = pinnedLlamaCppAsset(hardware, "prism")
    expect(asset.name).toBe(`llama-${PRISM_LLAMA_CPP_RELEASE_TAG}-bin-linux-cuda-13.3-x64.tar.gz`)
    expect(asset.companion).toMatchObject({
      name: "cudart-llama-b11057-bin-ubuntu-cuda-13.3-x64.tar.gz",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b11057/cudart-llama-b11057-bin-ubuntu-cuda-13.3-x64.tar.gz",
    })
  })

  it("keeps Prism on Vulkan on arm64, where its release has no Linux CUDA binary", () => {
    const hardware = {
      platform: "linux",
      arch: "arm64",
      backend: "cuda",
      cudaVersion: "13.4",
    } as const
    expect(llamaRuntimeTarget(hardware, "prism")).toEqual({
      ...hardware,
      backend: "vulkan",
      cudaVersion: undefined,
    })
    expect(pinnedLlamaCppAsset(hardware, "prism").name).toContain("ubuntu-vulkan-arm64")
    expect(pinnedLlamaCppAsset(hardware, "prism").companion).toBeUndefined()
  })

  it("pins Prism's llama.cpp fork for ternary models", () => {
    expect(PRISM_LLAMA_CPP_RELEASE_TAG).toBe("prism-b10685-7dffb15")
    expect(
      pinnedLlamaCppAsset({ platform: "darwin", arch: "arm64", backend: "metal" }, "prism"),
    ).toEqual({
      name: "llama-prism-b10685-7dffb15-bin-macos-arm64.tar.gz",
      url: "https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10685-7dffb15/llama-prism-b10685-7dffb15-bin-macos-arm64.tar.gz",
      size: 11_663_250,
      sha256: "7fffa7a40c74f3e9bd78f3f2f9f12f9befb7b13af45d5a69c239cf3fd37b9045",
    })
    expect(
      pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "vulkan" }, "prism"),
    ).toMatchObject({
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
