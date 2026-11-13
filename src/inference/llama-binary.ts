import type { CudaVersion, HardwareBackend } from "./hardware.js"

const LLAMA_CPP_RELEASE_TAG = "b12359"
/** Upstream's last CUDA 13.4 build, for R615 drivers, which CUDA 13.5's R620 branch excludes. */
const CUDA_13_4_RELEASE_TAG = "b11438"
const PRISM_LLAMA_CPP_RELEASE_TAG = "prism-b10685-7dffb15"
export const PINNED_LLAMA_CPP_RELEASE_TAGS = [
  LLAMA_CPP_RELEASE_TAG,
  PRISM_LLAMA_CPP_RELEASE_TAG,
] as const

export type LlamaRuntimeKind = "upstream" | "prism"

const UPSTREAM_LLAMA_CPP_ASSETS: Record<string, LlamaCppAssetMetadata> = {
  "llama-b12359-bin-macos-arm64.tar.gz": {
    size: 16_907_811,
    sha256: "82b00abc740160e1b9980e6cc79c117345fa34af058c80e6c0a69aa8ddccde75",
  },
  "llama-b12359-bin-macos-x64.tar.gz": {
    size: 12_661_621,
    sha256: "25320d529077ef5a3d16e7b5da26438f221d88c8c0930a32b0c79457f5eede56",
  },
  "llama-b12359-bin-ubuntu-arm64.tar.gz": {
    size: 18_949_862,
    sha256: "dc7aa17a67884619b7223870aca9fd6addbc01717713b04a714add1c31137359",
  },
  "llama-b12359-bin-ubuntu-vulkan-arm64.tar.gz": {
    size: 29_435_221,
    sha256: "3f8ae812a58ac92e5a596ca9fbc988f52854d147c5a7fe1264dddc90c1d085b4",
  },
  "llama-b12359-bin-ubuntu-vulkan-x64.tar.gz": {
    size: 36_153_377,
    sha256: "19b60f00395a3f4954e46a5037695bc1d843404fc9d3124f82a612ecd8fbe9f0",
  },
  "llama-b12359-bin-ubuntu-x64.tar.gz": {
    size: 23_311_084,
    sha256: "0bc1f091e8916102b6d8f2cf944233a620e90a0f856c72d0ce41150c65c2e72e",
  },
  "llama-b12359-bin-ubuntu-cuda-12.8-x64.tar.gz": {
    size: 199_223_370,
    sha256: "50c937bec5bbd9f74c99138034f7403283ee21f1943f2429d7b1e4c079eafc11",
  },
  "llama-b12359-bin-ubuntu-cuda-13.5-x64.tar.gz": {
    size: 178_419_847,
    sha256: "9440f417615bed0e191acef03bff0249117d2be74335358265a6d28475a9baf0",
  },
  "llama-b12359-bin-ubuntu-cuda-13.5-arm64.tar.gz": {
    size: 173_529_798,
    sha256: "e12fd3ca9a599349cac5ec767825e17f8cab9dc2dab8d8e5b85d50ce21ef6d7d",
  },
  "llama-b12359-bin-win-cpu-arm64.zip": {
    size: 13_455_326,
    sha256: "d27564c754478d2832789dfcebfc5ace018e36a224c41d810b7cbc1ba8243ec0",
  },
  "llama-b12359-bin-win-cpu-x64.zip": {
    size: 25_097_509,
    sha256: "837c1655e87df3b66989f4be33a792a1399c785bf259038dc75c900096683e69",
  },
  "llama-b12359-bin-win-vulkan-arm64.zip": {
    size: 26_027_698,
    sha256: "62cd50089cffdd825524a91c5a8819041eb75d8e2beacd6eca68194dba50574f",
  },
  "llama-b12359-bin-win-vulkan-x64.zip": {
    size: 38_090_643,
    sha256: "e8d18c6e4210cca87e7307c2ea78363ac8d158e4e1397358ec96ab70b53a0d5e",
  },
  "llama-b12359-bin-win-cuda-12.4-x64.zip": {
    size: 318_976_332,
    sha256: "e9c0abf442e8339c06728366c1ad2c711332f9939c0c00603fb75d85fd44c914",
  },
  "llama-b12359-bin-win-cuda-13.5-x64.zip": {
    size: 179_546_112,
    sha256: "1de9ca1ff408d6e348ea0007c6880ad2393311a02e7799bcde26dc16daef03dd",
  },
  "llama-b12359-bin-win-cuda-13.5-arm64.zip": {
    size: 167_147_417,
    sha256: "f40398808e74b88c3ccee904824667ef9825692843533e7fc22881ab2e4de9da",
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
 * official companion archives. Both llama.cpp builds use them; 13.4 builds take the libraries from
 * the 13.4 release, and Prism's 13.3 builds from the last release that shipped a 13.3 companion:
 * upstream b11057 on Linux, Prism's own release on Windows.
 */
const CUDA_RUNTIME_ARCHIVES: Record<string, LlamaCppArchive> = {
  "linux-12.8-x64": cudaRuntimeArchive(
    "ggml-org/llama.cpp",
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-b12359-bin-ubuntu-cuda-12.8-x64.tar.gz",
    {
      size: 594_371_571,
      sha256: "75a12d227f44a391608992329241765343bd143ee9445b90dc62e154ee726e5d",
    },
  ),
  "linux-13.5-x64": cudaRuntimeArchive(
    "ggml-org/llama.cpp",
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-b12359-bin-ubuntu-cuda-13.5-x64.tar.gz",
    {
      size: 444_078_822,
      sha256: "976a9146bb8a487a6ea701224d7fb14b05e494ab3c8f5c1799ffc4e5805d640c",
    },
  ),
  "linux-13.5-arm64": cudaRuntimeArchive(
    "ggml-org/llama.cpp",
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-b12359-bin-ubuntu-cuda-13.5-arm64.tar.gz",
    {
      size: 559_874_231,
      sha256: "998f62318999710d398dad40821d1d037731f360791e41628d9dfcde207909d1",
    },
  ),
  "linux-13.4-x64": cudaRuntimeArchive(
    "ggml-org/llama.cpp",
    CUDA_13_4_RELEASE_TAG,
    "cudart-llama-b11438-bin-ubuntu-cuda-13.4-x64.tar.gz",
    {
      size: 440_236_663,
      sha256: "6ab3154c677a23d2d475f7ed4358292cb8d1c4b1f5a68534cad813e0a62d2e83",
    },
  ),
  "linux-13.4-arm64": cudaRuntimeArchive(
    "ggml-org/llama.cpp",
    CUDA_13_4_RELEASE_TAG,
    "cudart-llama-b11438-bin-ubuntu-cuda-13.4-arm64.tar.gz",
    {
      size: 552_522_170,
      sha256: "703e7f7cbab48f68ac6e8556194419cd9f06614d4354b7597941ca58a5b8b92c",
    },
  ),
  "linux-13.3-x64": cudaRuntimeArchive(
    "ggml-org/llama.cpp",
    "b11057",
    "cudart-llama-b11057-bin-ubuntu-cuda-13.3-x64.tar.gz",
    {
      size: 410_248_824,
      sha256: "7a6ea3a0971055b41195ae92e6098842b5369995d360069fc06e392f64ea18f2",
    },
  ),
  "win32-12.4-x64": cudaRuntimeArchive(
    "ggml-org/llama.cpp",
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-bin-win-cuda-12.4-x64.zip",
    {
      size: 391_443_627,
      sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
    },
  ),
  "win32-13.5-x64": cudaRuntimeArchive(
    "ggml-org/llama.cpp",
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-bin-win-cuda-13.5-x64.zip",
    {
      size: 426_314_199,
      sha256: "c2bf4cc202bfbaaa7a0b75f5082457c3811326947bb216059b72839d844e9cba",
    },
  ),
  "win32-13.5-arm64": cudaRuntimeArchive(
    "ggml-org/llama.cpp",
    LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-bin-win-cuda-13.5-arm64.zip",
    {
      size: 278_821_062,
      sha256: "f89e7b2457f627d052dd99f42205ddfd01964454809754cdc649cffc74320dca",
    },
  ),
  "win32-13.4-x64": cudaRuntimeArchive(
    "ggml-org/llama.cpp",
    CUDA_13_4_RELEASE_TAG,
    "cudart-llama-bin-win-cuda-13.4-x64.zip",
    {
      size: 423_535_356,
      sha256: "738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668",
    },
  ),
  "win32-13.4-arm64": cudaRuntimeArchive(
    "ggml-org/llama.cpp",
    CUDA_13_4_RELEASE_TAG,
    "cudart-llama-bin-win-cuda-13.4-arm64.zip",
    {
      size: 153_262_407,
      sha256: "642dcde8805b3e3165ca710a5443b3b4044b27d96bd3ee3132473988c9bcb774",
    },
  ),
  "win32-13.3-x64": cudaRuntimeArchive(
    "PrismML-Eng/llama.cpp",
    PRISM_LLAMA_CPP_RELEASE_TAG,
    "cudart-llama-bin-win-cuda-13.3-x64.zip",
    {
      size: 390_970_417,
      sha256: "1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e",
    },
  ),
}

function cudaRuntimeArchive(
  repository: string,
  tag: string,
  name: string,
  metadata: LlamaCppAssetMetadata,
): LlamaCppArchive {
  return {
    name,
    url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
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
  "llama-prism-b10685-7dffb15-bin-win-cpu-arm64.zip": {
    size: 12_318_604,
    sha256: "169a55f0c02e8784810c5e92faa54e4717231a9c2d99fd38b4eb7e4f71025755",
  },
  "llama-prism-b10685-7dffb15-bin-win-cpu-x64.zip": {
    size: 18_758_803,
    sha256: "f877b5539021119714889be0e4aca8c1f97f399c2fe502b21e2113b3c9fba822",
  },
  "llama-prism-b10685-7dffb15-bin-win-vulkan-x64.zip": {
    size: 33_962_393,
    sha256: "f1e8090392390e5c26b184ff90f5350a5e6421bfdd74606f12c8c5de9c668b2b",
  },
  "llama-prism-b10685-7dffb15-bin-win-cuda-12.4-x64.zip": {
    size: 253_365_195,
    sha256: "7aa73f2c52081a7280fa4b02660ba902b964e461b0cfc0b652935e4a59b01c6e",
  },
  "llama-prism-b10685-7dffb15-bin-win-cuda-13.3-x64.zip": {
    size: 144_928_999,
    sha256: "0b0e44045b0b55bb892c5afa8fd4c988194c47c02967ff1da55cd01c0c8eda69",
  },
  "llama-prism-b10685-7dffb15-bin-win-cuda-13.4-arm64.zip": {
    size: 133_404_905,
    sha256: "395330f144411e0913a38f7cb32991a9027d762c0656e3f4c5456e0fc9086757",
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
    (target.platform === "darwin" || target.platform === "linux" || target.platform === "win32") &&
    (target.arch === "arm64" || target.arch === "x64")
  )
}

export function unsupportedLlamaCppTargetMessage(
  target: Pick<LlamaBinaryTarget, "platform" | "arch">,
) {
  return `Local inference is not supported on ${target.platform}/${target.arch}.`
}

export function llamaRuntimeReleaseTag(runtime: LlamaRuntimeKind, cudaVersion?: CudaVersion) {
  if (runtime === "prism") return PRISM_LLAMA_CPP_RELEASE_TAG
  return cudaVersion === "13.4" ? CUDA_13_4_RELEASE_TAG : LLAMA_CPP_RELEASE_TAG
}

/** The target Prism publishes a binary for, given the one the hardware probe chose. */
export function llamaRuntimeTarget<T extends LlamaBinaryTarget>(
  target: T,
  runtime: LlamaRuntimeKind,
): T {
  if (runtime !== "prism") return target
  if (target.backend === "cuda") {
    // Prism's newest CUDA builds are 13.3 on x64 and 13.4 on Windows arm64, which the drivers
    // that qualify a machine for 13.4 or 13.5 run as well. Its Linux CUDA binaries are x64 only.
    if (target.cudaVersion?.startsWith("13.") && target.arch === "x64")
      return { ...target, cudaVersion: "13.3" }
    if (target.cudaVersion === "13.5" && target.platform === "win32")
      return { ...target, cudaVersion: "13.4" }
    if (target.platform === "linux" && target.arch !== "x64")
      return { ...target, backend: "vulkan", cudaVersion: undefined }
    return target
  }
  // Prism publishes no Windows Vulkan build for arm64.
  if (target.backend === "vulkan" && target.platform === "win32" && target.arch === "arm64")
    return { ...target, backend: "cpu" }
  return target
}

export function pinnedLlamaCppAsset(
  target: LlamaBinaryTarget,
  runtime: LlamaRuntimeKind = "upstream",
): LlamaCppAsset {
  target = llamaRuntimeTarget(target, runtime)
  const prism = runtime === "prism"
  const releaseTag = llamaRuntimeReleaseTag(runtime, target.cudaVersion)
  const windows = target.platform === "win32"
  const extension = windows ? "zip" : "tar.gz"
  let name: string
  if (target.backend === "cuda") {
    if (target.platform === "darwin" || !supportsLlamaCppTarget(target) || !target.cudaVersion)
      throw new Error("CUDA requires a compatible Linux or Windows target.")
    const build = windows ? "win" : prism ? "linux" : "ubuntu"
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
  const companion = CUDA_RUNTIME_ARCHIVES[`${target.platform}-${target.cudaVersion}-${target.arch}`]
  if (!companion) throw new Error("No CUDA runtime companion is pinned for this target.")
  return { ...archive, companion }
}
