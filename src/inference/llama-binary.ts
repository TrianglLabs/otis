import type { CudaVersion, HardwareBackend } from "./hardware.js"

const LLAMA_CPP_RELEASE_TAG = "b12600"
/** Upstream's last CUDA 13.4 build, for R615 drivers, which CUDA 13.5's R620 branch excludes. */
const CUDA_13_4_RELEASE_TAG = "b11438"

const LLAMA_CPP_ASSETS: Record<string, LlamaCppAssetMetadata> = {
  "llama-b12600-bin-macos-arm64.tar.gz": {
    size: 16_578_695,
    sha256: "9ced6f8cbce915968a865ded7718c2c4d14a69876bf9abf544533aec9b76e975",
  },
  "llama-b12600-bin-macos-x64.tar.gz": {
    size: 12_364_702,
    sha256: "1a76c5393ebf51ee8e067de9042fe628303b976be639912a9bcf80feb71044af",
  },
  "llama-b12600-bin-ubuntu-arm64.tar.gz": {
    size: 18_732_505,
    sha256: "5e94888b3ca53f203bb894076f019baad60d0f6426c20fa13e6e3d5b7d769ebe",
  },
  "llama-b12600-bin-ubuntu-vulkan-arm64.tar.gz": {
    size: 29_849_537,
    sha256: "f5c457719413297b3911d70179739b692be755a743b4a39a505bcf110534a8d0",
  },
  "llama-b12600-bin-ubuntu-vulkan-x64.tar.gz": {
    size: 36_869_506,
    sha256: "33270a5d2034d268d07a970635639b22ad4411db945c092a3c472ab90513b2db",
  },
  "llama-b12600-bin-ubuntu-x64.tar.gz": {
    size: 23_189_794,
    sha256: "da524c71f9dd09913df29264bb7229b99a2de82d8a26e6902e6921d413560d6d",
  },
  "llama-b12600-bin-ubuntu-cuda-12.8-x64.tar.gz": {
    size: 220_051_870,
    sha256: "6b2bbca74c951e03e2cb45771410ac58590b6677257ae78e2c8a896bb0a3e1b2",
  },
  "llama-b12600-bin-ubuntu-cuda-13.5-x64.tar.gz": {
    size: 224_355_890,
    sha256: "78b119192451d00b6134f4c8decb4dd4343fc1156cec0dc11c8061bf92d7655b",
  },
  "llama-b12600-bin-ubuntu-cuda-13.5-arm64.tar.gz": {
    size: 219_263_613,
    sha256: "8435712a783efb71ddb0c1d92b13cf8ef32ff8df1b58ec62f6a1d2a63873cc38",
  },
  "llama-b12600-bin-win-cpu-arm64.zip": {
    size: 13_129_579,
    sha256: "0c9fc349a8864809af711b0309e3c014fcc7824cfcac4ac78ded55d238f3d2d5",
  },
  "llama-b12600-bin-win-cpu-x64.zip": {
    size: 25_012_254,
    sha256: "a31a14f1630408422228d02ff2a3fc41c06a6b3b3849d8d2782c37f0f6e30951",
  },
  "llama-b12600-bin-win-vulkan-arm64.zip": {
    size: 26_533_401,
    sha256: "9d803bf82a4dc849eaa780cab261b4c1dadefab829296a81054614e3121a6d5d",
  },
  "llama-b12600-bin-win-vulkan-x64.zip": {
    size: 38_857_771,
    sha256: "cca8bf28bf4193d0b7d674e8498bec8c8b82fb8fbd09a97759b79f542d984906",
  },
  "llama-b12600-bin-win-cuda-12.4-x64.zip": {
    size: 357_942_901,
    sha256: "6a8e0d292d387195087b3810f3675cf612fb86542378adccbafec808dd3511a7",
  },
  "llama-b12600-bin-win-cuda-13.5-x64.zip": {
    size: 225_604_843,
    sha256: "6c3d4724732b1a520e7e100585a0928e5a27521cd6d022fbab4b573dd1c0b52a",
  },
  "llama-b12600-bin-win-cuda-13.5-arm64.zip": {
    size: 212_945_223,
    sha256: "68e2a0729eb2f93fb45fadcf1474f0157f624fdf69e01b2c980cf537f5db42db",
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
    "cudart-llama-b12600-bin-ubuntu-cuda-12.8-x64.tar.gz",
    {
      size: 594_376_845,
      sha256: "971775211e47dad69f8143eab527893abaacdd69b91005ff3621c72692cfe199",
    },
  ),
  "linux-13.5-x64": cudaRuntimeArchive(
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-b12600-bin-ubuntu-cuda-13.5-x64.tar.gz",
    {
      size: 444_078_748,
      sha256: "323d3eb074f607b8fbbee8abefd9d6a0b895cc0751826ea598e9aafe4e5fedd5",
    },
  ),
  "linux-13.5-arm64": cudaRuntimeArchive(
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-b12600-bin-ubuntu-cuda-13.5-arm64.tar.gz",
    {
      size: 559_873_335,
      sha256: "6e8f4241a2ed3a89a4736e3eaa4e9590b565eebb5fb2d6176cbf8b96bf7cf904",
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
