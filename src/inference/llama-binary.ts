export const LLAMA_CPP_RELEASE_TAG = "b10964"
export const PRISM_LLAMA_CPP_RELEASE_TAG = "prism-b10685-7dffb15"
export const PINNED_LLAMA_CPP_RELEASE_TAGS = [LLAMA_CPP_RELEASE_TAG, PRISM_LLAMA_CPP_RELEASE_TAG] as const

export type LlamaRuntimeKind = "upstream" | "prism"

const UPSTREAM_LLAMA_CPP_ASSETS: Record<string, LlamaCppAssetMetadata> = {
  "llama-b10964-bin-macos-arm64.tar.gz": {
    size: 11_149_739,
    sha256: "033c845c1df9bf945ff37bb193238b40910b2244be3e1e637b2ceb5878f1a6f5",
  },
  "llama-b10964-bin-macos-x64.tar.gz": {
    size: 11_199_948,
    sha256: "03430a394d0a169a5e6d8f01c09f48cf58eb026af6fc95940a4a528e2e50cf38",
  },
  "llama-b10964-bin-ubuntu-arm64.tar.gz": {
    size: 13_451_337,
    sha256: "5f0e9c95d970892e43380f82ebcab960edfd20a1cd0f7abffa13b29fdb924949",
  },
  "llama-b10964-bin-ubuntu-vulkan-arm64.tar.gz": {
    size: 24_215_545,
    sha256: "f7864baa0edf5a059fb42c5efb5aceb96075aa1f41e6c3142b71ca69286cb0bb",
  },
  "llama-b10964-bin-ubuntu-vulkan-x64.tar.gz": {
    size: 30_166_472,
    sha256: "55d1e58e14c11eedea090bf088fdeefbfe7b4b09ee03bf6dba9834651769afcf",
  },
  "llama-b10964-bin-ubuntu-x64.tar.gz": {
    size: 16_825_086,
    sha256: "9abf88aea48a55d0f80edb1ee20220b186848cca0b4e919d71518cfd7ca67443",
  },
}

const PRISM_LLAMA_CPP_ASSETS: Record<string, LlamaCppAssetMetadata> = {
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

export type LlamaCppAsset = {
  name: string
  url: string
  size: number
  sha256: string
}

export type LlamaBinaryTarget = {
  platform: NodeJS.Platform
  arch: string
  backend: "metal" | "vulkan" | "cpu"
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

export function pinnedLlamaCppAsset(target: LlamaBinaryTarget, runtime: LlamaRuntimeKind = "upstream"): LlamaCppAsset {
  const releaseTag = llamaRuntimeReleaseTag(runtime)
  const name = assetName(target, releaseTag)
  const assets = runtime === "prism" ? PRISM_LLAMA_CPP_ASSETS : UPSTREAM_LLAMA_CPP_ASSETS
  const asset = assets[name]
  if (!asset) throw new Error(`No ${runtime} llama.cpp asset is pinned for ${target.platform}/${target.arch}.`)
  const repository = runtime === "prism" ? "PrismML-Eng/llama.cpp" : "ggml-org/llama.cpp"
  return {
    name,
    url: `https://github.com/${repository}/releases/download/${releaseTag}/${name}`,
    ...asset,
  }
}

function assetName(target: LlamaBinaryTarget, releaseTag: string) {
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
