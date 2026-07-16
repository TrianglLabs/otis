#!/usr/bin/env bun

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { $ } from "bun"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
process.chdir(root)

const pkg = await Bun.file(path.join(root, "package.json")).json()
const version = pkg.version
const publicDir = path.join("dist", "public")
const releaseDir = path.join(publicDir, "releases", `v${version}`)

const targets = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
]

type ReleaseArtifact = {
  path: string
  sha256: string
  size: number
}

const artifacts: Record<string, ReleaseArtifact> = {}
const checksums: string[] = []

await fs.promises.rm("dist", { recursive: true, force: true })
await fs.promises.mkdir(releaseDir, { recursive: true })

// Install all platform variants of @opentui/core so cross-compilation works.
await $`bun install --frozen-lockfile --os="*" --cpu="*"`

// Resolve the tree-sitter parser worker so it gets embedded in the compiled binary.
// Without this, OTUI_TREE_SITTER_WORKER_PATH is undefined and OpenTUI falls back to
// import.meta.url resolution, which fails in a compiled binary — tree-sitter never
// initializes and markdown/syntax highlighting silently degrades to plain text.
const parserWorkerPath = fs.realpathSync(path.resolve(root, "node_modules/@opentui/core/parser.worker.js"))

for (const target of targets) {
  const name = `otis-${target.os}-${target.arch}`
  const targetKey = `${target.os}-${target.arch}`
  const outDir = path.join("dist", "build", name)
  const binary = "otis"
  const binaryPath = path.join(outDir, binary)
  const archiveName = `${name}.tar.gz`
  const archivePath = path.join(releaseDir, archiveName)

  console.log(`Building ${name}...`)

  await fs.promises.mkdir(outDir, { recursive: true })

  const bunfsRoot = "/$bunfs/root/"
  const workerRelativePath = path.relative(root, parserWorkerPath).replaceAll("\\", "/")

  const result = await Bun.build({
    entrypoints: ["./src/cli/index.ts", parserWorkerPath],
    compile: {
      target: `bun-${target.os}-${target.arch}`,
      outfile: binaryPath,
    },
    sourcemap: "none",
    define: {
      "process.env.OTIS_VERSION": JSON.stringify(version),
      OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(bunfsRoot + workerRelativePath),
    },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`Build failed for ${name}`)
  }

  await fs.promises.chmod(binaryPath, 0o755)
  await $`tar -czf ${archivePath} -C ${outDir} ${binary}`

  const sha256 = await sha256File(archivePath)
  const size = (await fs.promises.stat(archivePath)).size
  artifacts[targetKey] = {
    path: archiveName,
    sha256,
    size,
  }
  checksums.push(`${sha256}  ${archiveName}`)

  console.log(`  -> ${archivePath}`)
}

const manifest = {
  version,
  artifacts,
}

await Bun.file(path.join(releaseDir, "checksums.txt")).write(`${checksums.join("\n")}\n`)
await Bun.file(path.join(releaseDir, "manifest.json")).write(`${JSON.stringify(manifest, null, 2)}\n`)
await fs.promises.mkdir(path.join(publicDir, "releases"), { recursive: true })
await Bun.file(path.join(publicDir, "releases", "latest.txt")).write(`${version}\n`)
await fs.promises.copyFile(path.join(root, "scripts", "install.sh"), path.join(publicDir, "install.sh"))

console.log("Done.")

async function sha256File(filePath: string) {
  const hash = crypto.createHash("sha256")
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest("hex")
}
