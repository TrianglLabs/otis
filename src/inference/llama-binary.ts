export type GitHubReleaseAsset = {
  name: string
  browser_download_url: string
  size: number
}

export type GitHubRelease = {
  tag_name: string
  prerelease?: boolean
  assets: GitHubReleaseAsset[]
}

export type LlamaBinaryTarget = {
  platform: NodeJS.Platform
  arch: string
  backend: "metal" | "vulkan" | "cpu"
}

export function selectLlamaCppAsset(release: GitHubRelease, target: LlamaBinaryTarget) {
  const wanted = assetNameFor(release.tag_name, target)
  const asset = release.assets.find((candidate) => candidate.name === wanted)
  if (!asset) {
    throw new Error(`llama.cpp ${release.tag_name} does not include ${wanted}.`)
  }
  return asset
}

export function assetNameFor(tag: string, target: LlamaBinaryTarget) {
  if (target.platform === "darwin" && target.arch === "arm64") return `llama-${tag}-bin-macos-arm64.tar.gz`
  if (target.platform === "darwin" && target.arch === "x64") return `llama-${tag}-bin-macos-x64.tar.gz`
  if (target.platform === "linux" && target.arch === "arm64") {
    return target.backend === "cpu"
      ? `llama-${tag}-bin-ubuntu-arm64.tar.gz`
      : `llama-${tag}-bin-ubuntu-vulkan-arm64.tar.gz`
  }
  if (target.platform === "linux" && target.arch === "x64") {
    return target.backend === "cpu" ? `llama-${tag}-bin-ubuntu-x64.tar.gz` : `llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`
  }
  throw new Error(`Local models are not supported on ${target.platform}/${target.arch}.`)
}

export function latestLlamaCppRelease(releases: readonly GitHubRelease[]) {
  const release = releases.find((candidate) => /^b\d+$/.test(candidate.tag_name) && candidate.assets.length > 0)
  if (!release) throw new Error("Could not find a llama.cpp build with downloadable binaries.")
  return release
}
