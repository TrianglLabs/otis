import type { CudaVersion, HardwareBackend } from "./hardware.js"

export const LLAMA_CPP_RELEASE_TAG = "b11057"
export const PRISM_LLAMA_CPP_RELEASE_TAG = "prism-b10685-7dffb15"
export const PINNED_LLAMA_CPP_RELEASE_TAGS = [LLAMA_CPP_RELEASE_TAG, PRISM_LLAMA_CPP_RELEASE_TAG] as const

export type LlamaRuntimeKind = "upstream" | "prism"

const UPSTREAM_LLAMA_CPP_ASSETS: Record<string, LlamaCppAssetMetadata> = {
  "llama-b11057-bin-macos-arm64.tar.gz": {
    size: 11_178_107,
    sha256: "443eadead90d44c3925b7163012430b2df4934df881cf72a4d94fc71d1380da1",
  },
  "llama-b11057-bin-macos-x64.tar.gz": {
    size: 11_216_033,
    sha256: "220c44e2c4405e2e1a660ea22c8fa5346ccc9fb3edcfc369038094ced64dc858",
  },
  "llama-b11057-bin-ubuntu-arm64.tar.gz": {
    size: 13_497_940,
    sha256: "9a3c641816b88ecbd1f5d1187d448d1d9501901ac5d931303669d4da829626d7",
  },
  "llama-b11057-bin-ubuntu-vulkan-arm64.tar.gz": {
    size: 24_335_721,
    sha256: "0c00ef5396a249f988c2e2998e8b4672456a3a4a73f681fd21ce645c5193e016",
  },
  "llama-b11057-bin-ubuntu-vulkan-x64.tar.gz": {
    size: 30_383_532,
    sha256: "30de01e5e9a0f4ccb65afeaa2ed2961d7beee71aaaf63167b9cc2a04a70b4178",
  },
  "llama-b11057-bin-ubuntu-x64.tar.gz": {
    size: 16_876_121,
    sha256: "fa7532f45d5b1c47696afb1cb7c334692262404c81ecc8e28b14dc273796289f",
  },
  "llama-b11057-bin-ubuntu-cuda-12.8-x64.tar.gz": {
    size: 168_842_418,
    sha256: "9def87abd480719ff7d80d8cbe8d55f2db75724049d1df0bd5d550e4438116c1",
  },
  "llama-b11057-bin-ubuntu-cuda-13.3-x64.tar.gz": {
    size: 149_142_938,
    sha256: "7f8d89f2dcdf110265ef1cde8e67065d089d9bea727832d526cd2e00027f3141",
  },
  "llama-b11057-bin-ubuntu-cuda-13.3-arm64.tar.gz": {
    size: 145_088_184,
    sha256: "a4b587b4c6c70f6e4a33aa7a59d5ae7459ace40554821b8b2ee35b802da868a0",
  },
  "cudart-llama-b11057-bin-ubuntu-cuda-12.8-x64.tar.gz": {
    size: 594_373_772,
    sha256: "9c14614404dddc29c9fc18eb4d7f6c9547e184f163a89fe4cf6c9bb5d3133ec5",
  },
  "cudart-llama-b11057-bin-ubuntu-cuda-13.3-x64.tar.gz": {
    size: 410_248_824,
    sha256: "7a6ea3a0971055b41195ae92e6098842b5369995d360069fc06e392f64ea18f2",
  },
  "cudart-llama-b11057-bin-ubuntu-cuda-13.3-arm64.tar.gz": {
    size: 518_393_019,
    sha256: "5cc384684ecf368b94c25fbb3ee16f2f6a2a3d2c04e4316c420cfae7d2f4fad2",
  },
}

const PRISM_LLAMA_CPP_ASSETS: Record<string, LlamaCppAssetMetadata> = {
  "llama-prism-b10685-7dffb15-bin-linux-cuda-12.8-x64.tar.gz": {
    size: 167_144_164,
    sha256: "4ec1572702fa3fd359653528fa5625fdd9c7ae02dedab7146da7773dae48cf2c",
  },
  "llama-prism-b10685-7dffb15-bin-linux-cuda-13.3-x64.tar.gz": {
    size: 146_277_406,
    sha256: "5f342ca9b618e4bd65f178bb5c1385e8978a00695c0bf552bb5d8c704e0b4a9f",
  },
  "llama-prism-b10685-7dffb15-bin-macos-arm64.tar.gz": {
    size: 11_663_250,
    sha256: "7fffa7a40c74f3e9bd78f3f2f9f12f9befb7b13af45d5a69c239cf3fd37b9045",
  },
  "llama-prism-b10685-7dffb15-bin-macos-x64.tar.gz": {
    size: 11_490_282,
    sha256: "b674befce466c4938e7e70a7b13009c7df2e76b072525495a78851c987a5121a",
  },
  "llama-prism-b10685-7dffb15-bin-ubuntu-arm64.tar.gz": {
    size: 13_724_176,
    sha256: "238f34e59c955eed38433ac5bfc0406ff48c4452768c2cc691c630678c34700d",
  },
  "llama-prism-b10685-7dffb15-bin-ubuntu-vulkan-arm64.tar.gz": {
    size: 27_974_741,
    sha256: "ae3d154bab4632b0cd47d2c00964ad12dfe06ab7e0ad535ddb8a61fb330fb64c",
  },
  "llama-prism-b10685-7dffb15-bin-ubuntu-vulkan-x64.tar.gz": {
    size: 34_218_725,
    sha256: "20aec2cce7e07b1df8a21a4bfef4b88db085210dac01b8a32374b5ed756f50e4",
  },
  "llama-prism-b10685-7dffb15-bin-ubuntu-x64.tar.gz": {
    size: 17_075_731,
    sha256: "a1fd3a575e70532567845815a042428831771661b857e80f06422fb08904cb7f",
  },
}

type LlamaCppAssetMetadata = {
  size: number
  sha256: string
}

export type LlamaCppArchive = {
  name: string
  url: string
  size: number
  sha256: string
}

export type LlamaCppAsset = LlamaCppArchive & {
  /** Official CUDA runtime/cuBLAS archive, installed beside llama-server. */
  companion?: LlamaCppArchive
}

export type LlamaBinaryTarget = {
  platform: NodeJS.Platform
  arch: string
  backend: HardwareBackend
  cudaVersion?: CudaVersion
}

export function supportsLlamaCppTarget(target: Pick<LlamaBinaryTarget, "platform" | "arch">) {
  return (
    (target.platform === "darwin" || target.platform === "linux") && (target.arch === "arm64" || target.arch === "x64")
  )
}

export function unsupportedLlamaCppTargetMessage(target: Pick<LlamaBinaryTarget, "platform" | "arch">) {
  return `Local inference is not supported on ${target.platform}/${target.arch}.`
}

export function llamaRuntimeReleaseTag(runtime: LlamaRuntimeKind) {
  return runtime === "prism" ? PRISM_LLAMA_CPP_RELEASE_TAG : LLAMA_CPP_RELEASE_TAG
}

export function llamaRuntimeTarget<T extends LlamaBinaryTarget>(target: T, runtime: LlamaRuntimeKind): T {
  // Prism publishes Linux CUDA binaries only for x64.
  return runtime === "prism" && target.backend === "cuda" && target.arch !== "x64"
    ? { ...target, backend: "vulkan", cudaVersion: undefined }
    : target
}

export function pinnedLlamaCppAsset(target: LlamaBinaryTarget, runtime: LlamaRuntimeKind = "upstream"): LlamaCppAsset {
  target = llamaRuntimeTarget(target, runtime)
  const releaseTag = llamaRuntimeReleaseTag(runtime)
  const name = assetName(target, releaseTag)
  const assets = runtime === "prism" ? PRISM_LLAMA_CPP_ASSETS : UPSTREAM_LLAMA_CPP_ASSETS
  const asset = assets[name]
  if (!asset) throw new Error(`No ${runtime} llama.cpp asset is pinned for ${target.platform}/${target.arch}.`)
  const repository = runtime === "prism" ? "PrismML-Eng/llama.cpp" : "ggml-org/llama.cpp"
  // NVIDIA's runtime/cuBLAS libraries are shared by both llama.cpp builds.
  // Use the pinned official companion for the same CUDA version and architecture;
  // all ggml/llama libraries still come exclusively from the selected runtime.
  const companionName = `cudart-llama-${LLAMA_CPP_RELEASE_TAG}-bin-ubuntu-cuda-${target.cudaVersion}-${target.arch}.tar.gz`
  const companion = target.backend === "cuda" ? UPSTREAM_LLAMA_CPP_ASSETS[companionName] : undefined
  if (target.backend === "cuda" && !companion) throw new Error("No CUDA runtime companion is pinned for this target.")
  return {
    name,
    url: `https://github.com/${repository}/releases/download/${releaseTag}/${name}`,
    ...asset,
    ...(companion
      ? {
          companion: {
            name: companionName,
            url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_RELEASE_TAG}/${companionName}`,
            ...companion,
          },
        }
      : {}),
  }
}

function assetName(target: LlamaBinaryTarget, releaseTag: string) {
  if (target.backend === "cuda") {
    if (target.platform !== "linux" || !target.cudaVersion) throw new Error("CUDA requires a compatible Linux target.")
    const platform = releaseTag === PRISM_LLAMA_CPP_RELEASE_TAG ? "linux" : "ubuntu"
    return `llama-${releaseTag}-bin-${platform}-cuda-${target.cudaVersion}-${target.arch}.tar.gz`
  }
  if (target.platform === "darwin" && target.arch === "arm64") {
    return `llama-${releaseTag}-bin-macos-arm64.tar.gz`
  }
  if (target.platform === "darwin" && target.arch === "x64") {
    return `llama-${releaseTag}-bin-macos-x64.tar.gz`
  }
  if (target.platform === "linux" && target.arch === "arm64") {
    return target.backend === "cpu"
      ? `llama-${releaseTag}-bin-ubuntu-arm64.tar.gz`
      : `llama-${releaseTag}-bin-ubuntu-vulkan-arm64.tar.gz`
  }
  if (target.platform === "linux" && target.arch === "x64") {
    return target.backend === "cpu"
      ? `llama-${releaseTag}-bin-ubuntu-x64.tar.gz`
      : `llama-${releaseTag}-bin-ubuntu-vulkan-x64.tar.gz`
  }
  throw new Error(unsupportedLlamaCppTargetMessage(target))
}
