export const LLAMA_CPP_RELEASE_TAG = "b10666"
export const PRISM_LLAMA_CPP_RELEASE_TAG = "prism-b10685-7dffb15"
export const PINNED_LLAMA_CPP_RELEASE_TAGS = [LLAMA_CPP_RELEASE_TAG, PRISM_LLAMA_CPP_RELEASE_TAG] as const

export type LlamaRuntimeKind = "upstream" | "prism"

const UPSTREAM_LLAMA_CPP_ASSETS: Record<string, LlamaCppAssetMetadata> = {
  "llama-b10666-bin-macos-arm64.tar.gz": {
    size: 11_022_594,
    sha256: "f2b5d7b445cfcdab2abe53e0e6e697790094fb902ef2bdaafd23c813bb297cbb",
  },
  "llama-b10666-bin-macos-x64.tar.gz": {
    size: 11_088_606,
    sha256: "5af9cd7fbcc226dbdba8d24e66e07b732903fc58eff0e38d829f04264f8d4601",
  },
  "llama-b10666-bin-ubuntu-arm64.tar.gz": {
    size: 13_124_929,
    sha256: "80e7e23689b9a8d541b45270a202db4f72de99ea52eabc4910373d8cc96e98fe",
  },
  "llama-b10666-bin-ubuntu-vulkan-arm64.tar.gz": {
    size: 26_878_255,
    sha256: "7293e6a49668e89b1d846b93151f3323bf29d99a73933a44264da0ac3cd5938f",
  },
  "llama-b10666-bin-ubuntu-vulkan-x64.tar.gz": {
    size: 33_018_827,
    sha256: "50fe0c5ffe5d28a8b7c27b083e6f159592eb6d9554c234c434dac43f7bb42588",
  },
  "llama-b10666-bin-ubuntu-x64.tar.gz": {
    size: 16_378_465,
    sha256: "a3c75af6f70ca504dc2712263f51099d4610cc00d59331066fc2335711f1993e",
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
