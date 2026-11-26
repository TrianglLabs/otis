import type { CudaVersion, HardwareBackend } from "./hardware.js"

const LLAMA_CPP_RELEASE_TAG = "b12776"
/** Upstream's last CUDA 13.4 build, for R615 drivers, which CUDA 13.5's R620 branch excludes. */
const CUDA_13_4_RELEASE_TAG = "b11438"

const LLAMA_CPP_ASSETS: Record<string, LlamaCppAssetMetadata> = {
  "llama-b12776-bin-macos-arm64.tar.gz": {
    size: 16_889_708,
    sha256: "cb0c5c97a1a4ad50a0d64e228a67694de5c3a876d1ae0077b39e3c2381f3a039",
  },
  "llama-b12776-bin-macos-x64.tar.gz": {
    size: 12_619_033,
    sha256: "e644d574b6800879163352cea41b4ebbe03d88a6704adab28dddbe44805f4918",
  },
  "llama-b12776-bin-ubuntu-arm64.tar.gz": {
    size: 19_013_663,
    sha256: "69a37e8fc18bf06214052d39fd83605846273ba08d7a6d88651e95788ca926db",
  },
  "llama-b12776-bin-ubuntu-vulkan-arm64.tar.gz": {
    size: 30_138_633,
    sha256: "068f25e73b6fbc83a56002b6cdb49ffe5143b02b03c553c8ebcf7e0993397443",
  },
  "llama-b12776-bin-ubuntu-vulkan-x64.tar.gz": {
    size: 37_166_385,
    sha256: "de4b743151f04d616eaadd0bbe962e1b7fb0c6f20edb738878899d3ed465043f",
  },
  "llama-b12776-bin-ubuntu-x64.tar.gz": {
    size: 23_454_955,
    sha256: "27e18f608c7cd1e2f86d70f91bde4299e795113c0065322f6339cbe5135e79c2",
  },
  "llama-b12776-bin-ubuntu-cuda-12.8-x64.tar.gz": {
    size: 220_351_062,
    sha256: "a264116d76b2bf41fdd4ff636fe1218f6dba2167faf2a164016ff48e38b0132a",
  },
  "llama-b12776-bin-ubuntu-cuda-13.5-x64.tar.gz": {
    size: 225_737_288,
    sha256: "c1ec29413577f5ddb9f65687da5649b0e0b3a1f820a0bedf1c8b7f2721817144",
  },
  "llama-b12776-bin-ubuntu-cuda-13.5-arm64.tar.gz": {
    size: 220_730_496,
    sha256: "e2463b2ea626fff57fa7abd9e9a90c9e8bde11d1fc9dd4796326904d99b8bb95",
  },
  "llama-b12776-bin-win-cpu-arm64.zip": {
    size: 13_358_743,
    sha256: "e0b56f7388e77bb7ee2adffa006ef41fe2485b2f5bf28eb3cc8ea16a96fdfa99",
  },
  "llama-b12776-bin-win-cpu-x64.zip": {
    size: 25_287_912,
    sha256: "bba23437a597b7b346acb87dbac2e5452c7b188cec67ca6315bec513a067ace8",
  },
  "llama-b12776-bin-win-vulkan-arm64.zip": {
    size: 26_792_137,
    sha256: "fe4e0be1d97a305e0bab0953db2ce593a71e80032f54e18d53d3c3284092a882",
  },
  "llama-b12776-bin-win-vulkan-x64.zip": {
    size: 39_159_731,
    sha256: "2202593e579709ed5a30d34604b4e75214cea4bef8d9449b64ef78848c3b52e5",
  },
  "llama-b12776-bin-win-cuda-12.4-x64.zip": {
    size: 357_982_680,
    sha256: "661637cfc6d75f63fd8bc9e837c70a2221a62eb1c91dea91088681ab878c238e",
  },
  "llama-b12776-bin-win-cuda-13.5-x64.zip": {
    size: 226_954_424,
    sha256: "83085e6e64d2874290e7fa7f8ec9e1a71469ba67d278de473b2a9a413e7fdef6",
  },
  "llama-b12776-bin-win-cuda-13.5-arm64.zip": {
    size: 214_244_192,
    sha256: "7e1661fd17657056d02029ec6218a86d2c4ed273c96e94faa0b7ea504acce818",
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
    "cudart-llama-b12776-bin-ubuntu-cuda-12.8-x64.tar.gz",
    {
      size: 594_379_015,
      sha256: "24c0d70f7616fc35707636c6ddb1a2cf5bc5ae569f6d41125fccc22ac7d6c008",
    },
  ),
  "linux-13.5-x64": cudaRuntimeArchive(
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-b12776-bin-ubuntu-cuda-13.5-x64.tar.gz",
    {
      size: 444_080_184,
      sha256: "69395ae36b1fc5ef0920f8b1513e4bf0a0a80a6eb15f1907f6986d04727e6db2",
    },
  ),
  "linux-13.5-arm64": cudaRuntimeArchive(
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-b12776-bin-ubuntu-cuda-13.5-arm64.tar.gz",
    {
      size: 559_873_925,
      sha256: "83b5b7a29ee1ad9777dac4809937299c8a661f2a69569cfe4eae1dc945729136",
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
