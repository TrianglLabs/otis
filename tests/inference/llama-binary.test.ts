import { describe, expect, it } from "vitest"
import {
  type LlamaRuntimeKind,
  llamaRuntimeReleaseTag,
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
    expect(LLAMA_CPP_RELEASE_TAG).toBe("b12359")
    expect(pinnedLlamaCppAsset({ platform: "darwin", arch: "arm64", backend: "metal" })).toEqual({
      name: "llama-b12359-bin-macos-arm64.tar.gz",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-macos-arm64.tar.gz",
      size: 16_907_811,
      sha256: "82b00abc740160e1b9980e6cc79c117345fa34af058c80e6c0a69aa8ddccde75",
    })
    expect(pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "vulkan" }).name).toBe(
      "llama-b12359-bin-ubuntu-vulkan-x64.tar.gz",
    )
    expect(pinnedLlamaCppAsset({ platform: "linux", arch: "x64", backend: "cpu" }).name).toBe(
      "llama-b12359-bin-ubuntu-x64.tar.gz",
    )
  })

  it.each([
    ["x64", "12.8", "b12359"],
    ["x64", "13.5", "b12359"],
    ["arm64", "13.5", "b12359"],
    // R615 drivers keep the last 13.4 release, since 13.5 needs R620.
    ["x64", "13.4", "b11438"],
    ["arm64", "13.4", "b11438"],
  ] as const)("pairs Linux %s CUDA %s with the matching official runtime libraries from %s", (arch, cudaVersion, tag) => {
    const asset = pinnedLlamaCppAsset({ platform: "linux", arch, backend: "cuda", cudaVersion })
    expect(llamaRuntimeReleaseTag("upstream", cudaVersion)).toBe(tag)
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

  it.each([
    "13.4",
    "13.5",
  ] as const)("runs Prism's 13.3 build on a CUDA %s machine, with the last 13.3 companion", (cudaVersion) => {
    const hardware = { platform: "linux", arch: "x64", backend: "cuda", cudaVersion } as const
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
      cudaVersion: "13.5",
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
      name: "llama-b12359-bin-win-cpu-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-win-cpu-x64.zip",
      size: 25_097_509,
      sha256: "837c1655e87df3b66989f4be33a792a1399c785bf259038dc75c900096683e69",
    })
    expect(pinnedLlamaCppAsset({ platform: "win32", arch: "arm64", backend: "vulkan" }).name).toBe(
      "llama-b12359-bin-win-vulkan-arm64.zip",
    )
    for (const [arch, cudaVersion, tag] of [
      ["x64", "12.4", "b12359"],
      ["x64", "13.5", "b12359"],
      ["arm64", "13.5", "b12359"],
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

  it("maps Prism's Windows builds: 13.3 CUDA on x64 with its own cudart, CPU where it has no Vulkan", () => {
    const x64 = { platform: "win32", arch: "x64", backend: "cuda", cudaVersion: "13.4" } as const
    const asset = pinnedLlamaCppAsset(x64, "prism")
    expect(llamaRuntimeTarget(x64, "prism")).toEqual({ ...x64, cudaVersion: "13.3" })
    expect(asset.name).toBe(`llama-${PRISM_LLAMA_CPP_RELEASE_TAG}-bin-win-cuda-13.3-x64.zip`)
    expect(asset.companion?.url).toBe(
      `https://github.com/PrismML-Eng/llama.cpp/releases/download/${PRISM_LLAMA_CPP_RELEASE_TAG}/cudart-llama-bin-win-cuda-13.3-x64.zip`,
    )
    // Prism's arm64 CUDA build is 13.4, which a 13.5 machine's R620 driver runs as well.
    const arm64 = {
      platform: "win32",
      arch: "arm64",
      backend: "cuda",
      cudaVersion: "13.4",
    } as const
    expect(llamaRuntimeTarget(arm64, "prism")).toEqual(arm64)
    expect(llamaRuntimeTarget({ ...arm64, cudaVersion: "13.5" }, "prism")).toEqual(arm64)
    expect(pinnedLlamaCppAsset({ ...arm64, cudaVersion: "13.5" }, "prism").companion?.url).toBe(
      "https://github.com/ggml-org/llama.cpp/releases/download/b11438/cudart-llama-bin-win-cuda-13.4-arm64.zip",
    )
    const vulkan = { platform: "win32", arch: "arm64", backend: "vulkan" } as const
    expect(llamaRuntimeTarget(vulkan, "prism")).toEqual({ ...vulkan, backend: "cpu" })
    expect(pinnedLlamaCppAsset(vulkan, "prism").name).toBe(
      `llama-${PRISM_LLAMA_CPP_RELEASE_TAG}-bin-win-cpu-arm64.zip`,
    )
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
