import type { CudaVersion, HardwareBackend } from "./hardware.js"

const LLAMA_CPP_RELEASE_TAG = "b12728"
/** Upstream's last CUDA 13.4 build, for R615 drivers, which CUDA 13.5's R620 branch excludes. */
const CUDA_13_4_RELEASE_TAG = "b11438"

const LLAMA_CPP_ASSETS: Record<string, LlamaCppAssetMetadata> = {
  "llama-b12728-bin-macos-arm64.tar.gz": {
    size: 16_834_886,
    sha256: "001140842db7fa5253e57f891c14db5377937faf07d955a2646b471df0e7d9bd",
  },
  "llama-b12728-bin-macos-x64.tar.gz": {
    size: 12_557_446,
    sha256: "817b0faa91432ff32ccd6895a7b11a19f0d6ee57d3800c75e93c7d78265c1a9d",
  },
  "llama-b12728-bin-ubuntu-arm64.tar.gz": {
    size: 18_951_947,
    sha256: "fd00c6490374e11509e22feebfeb3e576662736a18c1ce56b190e388c2e7b003",
  },
  "llama-b12728-bin-ubuntu-vulkan-arm64.tar.gz": {
    size: 30_078_554,
    sha256: "49661bc1b434d77385e7cffa5741c874155276c4de2b2463c3033938d7a7f859",
  },
  "llama-b12728-bin-ubuntu-vulkan-x64.tar.gz": {
    size: 37_107_359,
    sha256: "99b1a7a54829fa53964c5db6ab34c5f9a7734fb8029506e55bf3d04e24ba4979",
  },
  "llama-b12728-bin-ubuntu-x64.tar.gz": {
    size: 23_392_294,
    sha256: "7c8d787ff15384423d6742a42fad8e7e453d61b94a9c4cd85296e800d538b178",
  },
  "llama-b12728-bin-ubuntu-cuda-12.8-x64.tar.gz": {
    size: 220_573_131,
    sha256: "fa933e8c59cecfca0f4eda3358afca026fb1557f857a7e86896820fabef7b0af",
  },
  "llama-b12728-bin-ubuntu-cuda-13.5-x64.tar.gz": {
    size: 224_917_210,
    sha256: "69bc2ff5eb78f86ab91a9be5523282d201a87228b2782cae4a186e6cf4dd3e69",
  },
  "llama-b12728-bin-ubuntu-cuda-13.5-arm64.tar.gz": {
    size: 219_840_618,
    sha256: "4e2487045f76f929df999ac3a4d90085cb30e07873a4090141e0fc966fc1a4b1",
  },
  "llama-b12728-bin-win-cpu-arm64.zip": {
    size: 13_299_036,
    sha256: "c4babfa1a8ba38b7a86f3719c7254cf15b918eca81179b1a0c76a23779d3985a",
  },
  "llama-b12728-bin-win-cpu-x64.zip": {
    size: 25_230_941,
    sha256: "a8ace09d44bb10e2617268c55c3f2db0e0adeedd9c1ba722969920665a3ae698",
  },
  "llama-b12728-bin-win-vulkan-arm64.zip": {
    size: 26_735_751,
    sha256: "e8deb834cbd0e0cdece4b5a11831acc0ba2e262c11f26d0aece125499bd6d8e9",
  },
  "llama-b12728-bin-win-vulkan-x64.zip": {
    size: 39_101_990,
    sha256: "d95e91824e3efc5a0de2746ba09a99700e9b81e741573e0b7ffbe404e500257d",
  },
  "llama-b12728-bin-win-cuda-12.4-x64.zip": {
    size: 358_626_875,
    sha256: "85b6e332ed7b40fd7a240ac7f32c4f1a29e9ddf6b52853925a215fda23ef24b3",
  },
  "llama-b12728-bin-win-cuda-13.5-x64.zip": {
    size: 226_090_452,
    sha256: "dc4a26a3b6c8b5c8a5437963e3dd7edd0a6ac4d1e585306291f5bb4d8ee235cd",
  },
  "llama-b12728-bin-win-cuda-13.5-arm64.zip": {
    size: 213_434_775,
    sha256: "79dbb977647adb319f20b28f8efe35e6c8d7f8173c5bafe9729883d513ff66cf",
  },
  "llama-b11438-bin-ubuntu-cuda-13.4-x64.tar.gz": {
    size: 152_519_019,
    sha256: "3573b47d2113833f86e29ad7692b6edbbd64cc132364b59cd7a48d752390b3db",
  },
  "llama-b11438-bin-ubuntu-cuda-13.4-arm64.tar.gz": {
    size: 147_640_434,
    sha256: "b03a5eaf34bc508e3240f2318d40a2d40ac04e88695e499995f1cd0576ab2dce",
  },
  "llama-b11438-bin-win-cuda-13.4-x64.zip": {
    size: 153_089_651,
    sha256: "f05da20ea7d7cd07166d5bb08fc0319a156a0f439ab5da64b51f1a19818beb3b",
  },
  "llama-b11438-bin-win-cuda-13.4-arm64.zip": {
    size: 145_269_254,
    sha256: "5735d966333484e6aea2a39576369157bff2894071156f91af5249e3375ec472",
  },
}

/**
 * NVIDIA's runtime/cuBLAS libraries, by platform, CUDA version and architecture, from the
 * official companion archives; 13.4 builds take the libraries from the 13.4 release.
 */
const CUDA_RUNTIME_ARCHIVES: Record<string, LlamaCppArchive> = {
  "linux-12.8-x64": cudaRuntimeArchive(
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-b12728-bin-ubuntu-cuda-12.8-x64.tar.gz",
    {
      size: 594_371_473,
      sha256: "682f4ee2bd14383654ec918b03c33f544db1c3f8490af2171447f18e24b79e73",
    },
  ),
  "linux-13.5-x64": cudaRuntimeArchive(
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-b12728-bin-ubuntu-cuda-13.5-x64.tar.gz",
    {
      size: 444_078_952,
      sha256: "040197cd2f0e08da395f7fe0a6d78feaca37f72af7c16db04852dc9ab14a71c1",
    },
  ),
  "linux-13.5-arm64": cudaRuntimeArchive(
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-b12728-bin-ubuntu-cuda-13.5-arm64.tar.gz",
    {
      size: 559_872_707,
      sha256: "bde425dd8cc70c84d0a632a0aff8311812b5bf5632c4225029c29c0b93a8b0dd",
    },
  ),
  "linux-13.4-x64": cudaRuntimeArchive(
    CUDA_13_4_RELEASE_TAG,
    "cudart-llama-b11438-bin-ubuntu-cuda-13.4-x64.tar.gz",
    {
      size: 440_236_663,
      sha256: "6ab3154c677a23d2d475f7ed4358292cb8d1c4b1f5a68534cad813e0a62d2e83",
    },
  ),
  "linux-13.4-arm64": cudaRuntimeArchive(
    CUDA_13_4_RELEASE_TAG,
    "cudart-llama-b11438-bin-ubuntu-cuda-13.4-arm64.tar.gz",
    {
      size: 552_522_170,
      sha256: "703e7f7cbab48f68ac6e8556194419cd9f06614d4354b7597941ca58a5b8b92c",
    },
  ),
  "win32-12.4-x64": cudaRuntimeArchive(
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-bin-win-cuda-12.4-x64.zip",
    {
      size: 391_443_627,
      sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
    },
  ),
  "win32-13.5-x64": cudaRuntimeArchive(
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-bin-win-cuda-13.5-x64.zip",
    {
      size: 426_314_199,
      sha256: "c2bf4cc202bfbaaa7a0b75f5082457c3811326947bb216059b72839d844e9cba",
    },
  ),
  "win32-13.5-arm64": cudaRuntimeArchive(
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-bin-win-cuda-13.5-arm64.zip",
    {
      size: 278_821_062,
      sha256: "f89e7b2457f627d052dd99f42205ddfd01964454809754cdc649cffc74320dca",
    },
  ),
  "win32-13.4-x64": cudaRuntimeArchive(
    CUDA_13_4_RELEASE_TAG,
    "cudart-llama-bin-win-cuda-13.4-x64.zip",
    {
      size: 423_535_356,
      sha256: "738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668",
    },
  ),
  "win32-13.4-arm64": cudaRuntimeArchive(
    CUDA_13_4_RELEASE_TAG,
    "cudart-llama-bin-win-cuda-13.4-arm64.zip",
    {
      size: 153_262_407,
      sha256: "642dcde8805b3e3165ca710a5443b3b4044b27d96bd3ee3132473988c9bcb774",
    },
  ),
}

function cudaRuntimeArchive(
  tag: string,
  name: string,
  metadata: LlamaCppAssetMetadata,
): LlamaCppArchive {
  return {
    name,
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${name}`,
    ...metadata,
  }
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
    (target.platform === "darwin" || target.platform === "linux" || target.platform === "win32") &&
    (target.arch === "arm64" || target.arch === "x64")
  )
}

export function unsupportedLlamaCppTargetMessage(
  target: Pick<LlamaBinaryTarget, "platform" | "arch">,
) {
  return `Local inference is not supported on ${target.platform}/${target.arch}.`
}

export function llamaRuntimeReleaseTag(cudaVersion?: CudaVersion) {
  return cudaVersion === "13.4" ? CUDA_13_4_RELEASE_TAG : LLAMA_CPP_RELEASE_TAG
}

export function pinnedLlamaCppAsset(target: LlamaBinaryTarget): LlamaCppAsset {
  const releaseTag = llamaRuntimeReleaseTag(target.cudaVersion)
  const windows = target.platform === "win32"
  const extension = windows ? "zip" : "tar.gz"
  let name: string
  if (target.backend === "cuda") {
    if (target.platform === "darwin" || !supportsLlamaCppTarget(target) || !target.cudaVersion)
      throw new Error("CUDA requires a compatible Linux or Windows target.")
    const build = windows ? "win" : "ubuntu"
    name = `llama-${releaseTag}-bin-${build}-cuda-${target.cudaVersion}-${target.arch}.${extension}`
  } else {
    if (!supportsLlamaCppTarget(target)) throw new Error(unsupportedLlamaCppTargetMessage(target))
    const build =
      target.platform === "darwin"
        ? "macos"
        : windows
          ? `win-${target.backend}`
          : target.backend === "cpu"
            ? "ubuntu"
            : "ubuntu-vulkan"
    name = `llama-${releaseTag}-bin-${build}-${target.arch}.${extension}`
  }
  const asset = LLAMA_CPP_ASSETS[name]
  if (!asset) throw new Error(`No llama.cpp asset is pinned for ${target.platform}/${target.arch}.`)
  const archive = {
    name,
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${releaseTag}/${name}`,
    ...asset,
  }
  if (target.backend !== "cuda") return archive
  // The companion carries NVIDIA's libraries for the same CUDA version and architecture; every
  // ggml/llama library still comes from the llama.cpp archive.
  const companion = CUDA_RUNTIME_ARCHIVES[`${target.platform}-${target.cudaVersion}-${target.arch}`]
  if (!companion) throw new Error("No CUDA runtime companion is pinned for this target.")
  return { ...archive, companion }
}
