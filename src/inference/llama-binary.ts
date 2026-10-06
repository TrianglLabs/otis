import type { CudaVersion, HardwareBackend } from "./hardware.js"

const LLAMA_CPP_RELEASE_TAG = "b11438"
const PRISM_LLAMA_CPP_RELEASE_TAG = "prism-b10685-7dffb15"
export const PINNED_LLAMA_CPP_RELEASE_TAGS = [
  LLAMA_CPP_RELEASE_TAG,
  PRISM_LLAMA_CPP_RELEASE_TAG,
] as const

export type LlamaRuntimeKind = "upstream" | "prism"

const UPSTREAM_LLAMA_CPP_ASSETS: Record<string, LlamaCppAssetMetadata> = {
  "llama-b11438-bin-macos-arm64.tar.gz": {
    size: 11_971_002,
    sha256: "a19734f6cbfc011661ce517173bf3ccdb43d1e054038f73f44c1f9d8c2789132",
  },
  "llama-b11438-bin-macos-x64.tar.gz": {
    size: 11_486_947,
    sha256: "0cadca1306d7b8c533f22a3293a35787e012261d43704c82fa60d8b29c7bb40d",
  },
  "llama-b11438-bin-ubuntu-arm64.tar.gz": {
    size: 13_681_020,
    sha256: "fa3600d62125eed3ee96e6acae79bec3ad8ef8f54fa2ba432289e7ad579f740c",
  },
  "llama-b11438-bin-ubuntu-vulkan-arm64.tar.gz": {
    size: 24_844_211,
    sha256: "d0a270f014be3504d4599859a3e8c7820ccfff37c82bc3453793c855dacccca0",
  },
  "llama-b11438-bin-ubuntu-vulkan-x64.tar.gz": {
    size: 31_635_148,
    sha256: "43405007f3fb145429e920888666cbc6acbb49bef596cde098d85c74f899afd2",
  },
  "llama-b11438-bin-ubuntu-x64.tar.gz": {
    size: 17_692_768,
    sha256: "afd4262e6f41b3c9d7b41605c4e080969f8343a12a72a5c1c732f59555c92a1e",
  },
  "llama-b11438-bin-ubuntu-cuda-12.8-x64.tar.gz": {
    size: 171_652_707,
    sha256: "acbeb6b85c9af12f09e811f83c6647b255c79f0552966dc831b1617bdb7e1af9",
  },
  "llama-b11438-bin-ubuntu-cuda-13.4-x64.tar.gz": {
    size: 152_519_019,
    sha256: "3573b47d2113833f86e29ad7692b6edbbd64cc132364b59cd7a48d752390b3db",
  },
  "llama-b11438-bin-ubuntu-cuda-13.4-arm64.tar.gz": {
    size: 147_640_434,
    sha256: "b03a5eaf34bc508e3240f2318d40a2d40ac04e88695e499995f1cd0576ab2dce",
  },
}

/**
 * NVIDIA's runtime/cuBLAS libraries, by CUDA version and architecture, from upstream's official
 * companion archives. Both llama.cpp builds use them; Prism's 13.3 build takes the libraries from
 * the last upstream release that shipped a 13.3 companion.
 */
const CUDA_RUNTIME_ARCHIVES: Record<string, LlamaCppArchive> = {
  "12.8-x64": cudaRuntimeArchive("b11438", "12.8", "x64", {
    size: 594_377_525,
    sha256: "96c4a60c5854a34a6d2f8e4cf217dc25b9f0ecb73fcf6015ee20881aa0fe496b",
  }),
  "13.4-x64": cudaRuntimeArchive("b11438", "13.4", "x64", {
    size: 440_236_663,
    sha256: "6ab3154c677a23d2d475f7ed4358292cb8d1c4b1f5a68534cad813e0a62d2e83",
  }),
  "13.4-arm64": cudaRuntimeArchive("b11438", "13.4", "arm64", {
    size: 552_522_170,
    sha256: "703e7f7cbab48f68ac6e8556194419cd9f06614d4354b7597941ca58a5b8b92c",
  }),
  "13.3-x64": cudaRuntimeArchive("b11057", "13.3", "x64", {
    size: 410_248_824,
    sha256: "7a6ea3a0971055b41195ae92e6098842b5369995d360069fc06e392f64ea18f2",
  }),
}

function cudaRuntimeArchive(
  tag: string,
  cuda: string,
  arch: string,
  metadata: LlamaCppAssetMetadata,
): LlamaCppArchive {
  const name = `cudart-llama-${tag}-bin-ubuntu-cuda-${cuda}-${arch}.tar.gz`
  return {
    name,
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${name}`,
    ...metadata,
  }
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
    (target.platform === "darwin" || target.platform === "linux") &&
    (target.arch === "arm64" || target.arch === "x64")
  )
}

export function unsupportedLlamaCppTargetMessage(
  target: Pick<LlamaBinaryTarget, "platform" | "arch">,
) {
  return `Local inference is not supported on ${target.platform}/${target.arch}.`
}

export function llamaRuntimeReleaseTag(runtime: LlamaRuntimeKind) {
  return runtime === "prism" ? PRISM_LLAMA_CPP_RELEASE_TAG : LLAMA_CPP_RELEASE_TAG
}

export function llamaRuntimeTarget<T extends LlamaBinaryTarget>(
  target: T,
  runtime: LlamaRuntimeKind,
): T {
  if (runtime !== "prism" || target.backend !== "cuda") return target
  // Prism publishes Linux CUDA binaries only for x64, and its newest CUDA build is 13.3, which
  // the R615 driver that qualifies a machine for 13.4 runs as well.
  if (target.arch !== "x64") return { ...target, backend: "vulkan", cudaVersion: undefined }
  return target.cudaVersion === "13.4" ? { ...target, cudaVersion: "13.3" } : target
}

export function pinnedLlamaCppAsset(
  target: LlamaBinaryTarget,
  runtime: LlamaRuntimeKind = "upstream",
): LlamaCppAsset {
  target = llamaRuntimeTarget(target, runtime)
  const prism = runtime === "prism"
  const releaseTag = llamaRuntimeReleaseTag(runtime)
  let name: string
  if (target.backend === "cuda") {
    if (target.platform !== "linux" || !target.cudaVersion)
      throw new Error("CUDA requires a compatible Linux target.")
    const distro = prism ? "linux" : "ubuntu"
    name = `llama-${releaseTag}-bin-${distro}-cuda-${target.cudaVersion}-${target.arch}.tar.gz`
  } else {
    if (!supportsLlamaCppTarget(target)) throw new Error(unsupportedLlamaCppTargetMessage(target))
    const build =
      target.platform === "darwin" ? "macos" : target.backend === "cpu" ? "ubuntu" : "ubuntu-vulkan"
    name = `llama-${releaseTag}-bin-${build}-${target.arch}.tar.gz`
  }
  const asset = (prism ? PRISM_LLAMA_CPP_ASSETS : UPSTREAM_LLAMA_CPP_ASSETS)[name]
  if (!asset)
    throw new Error(
      `No ${runtime} llama.cpp asset is pinned for ${target.platform}/${target.arch}.`,
    )
  const repository = prism ? "PrismML-Eng/llama.cpp" : "ggml-org/llama.cpp"
  const archive = {
    name,
    url: `https://github.com/${repository}/releases/download/${releaseTag}/${name}`,
    ...asset,
  }
  if (target.backend !== "cuda") return archive
  // The companion carries NVIDIA's libraries for the same CUDA version and architecture; every
  // ggml/llama library still comes exclusively from the selected runtime.
  const companion = CUDA_RUNTIME_ARCHIVES[`${target.cudaVersion}-${target.arch}`]
  if (!companion) throw new Error("No CUDA runtime companion is pinned for this target.")
  return { ...archive, companion }
}
