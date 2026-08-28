export const LLAMA_CPP_RELEASE_TAG = "b10666"

const LLAMA_CPP_RELEASE_BASE_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_RELEASE_TAG}`

const LLAMA_CPP_ASSETS = {
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
} as const

export type LlamaCppAsset = {
  name: keyof typeof LLAMA_CPP_ASSETS
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

export function pinnedLlamaCppAsset(target: LlamaBinaryTarget): LlamaCppAsset {
  const name = assetName(target)
  return { name, url: `${LLAMA_CPP_RELEASE_BASE_URL}/${name}`, ...LLAMA_CPP_ASSETS[name] }
}

function assetName(target: LlamaBinaryTarget): keyof typeof LLAMA_CPP_ASSETS {
  if (target.platform === "darwin" && target.arch === "arm64") {
    return `llama-${LLAMA_CPP_RELEASE_TAG}-bin-macos-arm64.tar.gz`
  }
  if (target.platform === "darwin" && target.arch === "x64") {
    return `llama-${LLAMA_CPP_RELEASE_TAG}-bin-macos-x64.tar.gz`
  }
  if (target.platform === "linux" && target.arch === "arm64") {
    return target.backend === "cpu"
      ? `llama-${LLAMA_CPP_RELEASE_TAG}-bin-ubuntu-arm64.tar.gz`
      : `llama-${LLAMA_CPP_RELEASE_TAG}-bin-ubuntu-vulkan-arm64.tar.gz`
  }
  if (target.platform === "linux" && target.arch === "x64") {
    return target.backend === "cpu"
      ? `llama-${LLAMA_CPP_RELEASE_TAG}-bin-ubuntu-x64.tar.gz`
      : `llama-${LLAMA_CPP_RELEASE_TAG}-bin-ubuntu-vulkan-x64.tar.gz`
  }
  throw new Error(unsupportedLlamaCppTargetMessage(target))
}
