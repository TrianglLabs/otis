export const LLAMA_CPP_RELEASE_TAG = "b10622"

const LLAMA_CPP_RELEASE_BASE_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_RELEASE_TAG}`

const LLAMA_CPP_ASSETS = {
  "llama-b10622-bin-macos-arm64.tar.gz": {
    size: 10_954_906,
    sha256: "c0116ec9957477a9c77e68d3cf31e79f9aede1a9210861c7c09d74acc3e9c3cf",
  },
  "llama-b10622-bin-macos-x64.tar.gz": {
    size: 11_034_210,
    sha256: "b772320b22bc5cf845930088c985012b94e284242c2ad05fad174297eb5e373e",
  },
  "llama-b10622-bin-ubuntu-arm64.tar.gz": {
    size: 13_042_868,
    sha256: "6730946e555d57cdd29ad28f9d445a9195fa3d72d5ed076fa6dcfe25a4f4c266",
  },
  "llama-b10622-bin-ubuntu-vulkan-arm64.tar.gz": {
    size: 26_775_532,
    sha256: "743e7d3ee6297daa22cdc5b2262ebed93512bdffaf3d5c7f05c24ff60e7e78cb",
  },
  "llama-b10622-bin-ubuntu-vulkan-x64.tar.gz": {
    size: 32_916_111,
    sha256: "2e9a07037f1aa89f9ccd85acc6a376c503a369e3feb916b42d8e9a1542c8828e",
  },
  "llama-b10622-bin-ubuntu-x64.tar.gz": {
    size: 16_291_802,
    sha256: "6cc895c67bfa868faccda8aca06ec136e489609fc20f068550214f149d94fb4c",
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
