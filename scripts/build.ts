#!/usr/bin/env bun

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { $ } from "bun"
import JSZip from "jszip"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
process.chdir(root)

const pkg = await Bun.file(path.join(root, "package.json")).json()
const version = pkg.version
const publicDir = path.join("dist", "public")
const releaseDir = path.join(publicDir, "releases", `v${version}`)

// Bun compiles Windows for x64 only; Windows on Arm runs that build through its x64 emulation.
const targets = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "windows", arch: "x64" },
]

const artifacts: Record<string, { path: string; sha256: string; size: number }> = {}
const checksums: string[] = []

await fs.promises.rm("dist", { recursive: true, force: true })
await fs.promises.mkdir(releaseDir, { recursive: true })

// Install all platform variants of @opentui/core so cross-compilation works.
await $`bun install --frozen-lockfile --os="*" --cpu="*"`

// Resolve the tree-sitter parser worker so it gets embedded in the compiled binary.
// Without this, OTUI_TREE_SITTER_WORKER_PATH is undefined and OpenTUI falls back to
// import.meta.url resolution, which fails in a compiled binary — tree-sitter never
// initializes and markdown/syntax highlighting silently degrades to plain text.
const parserWorkerPath = fs.realpathSync(
  path.resolve(root, "node_modules/@opentui/core/parser.worker.js"),
)

for (const target of targets) {
  const windows = target.os === "windows"
  const name = `otis-${target.os}-${target.arch}`
  const targetKey = `${target.os}-${target.arch}`
  const outDir = path.join("dist", "build", name)
  const binary = windows ? "otis.exe" : "otis"
  const binaryPath = path.join(outDir, binary)
  // Windows has a zip reader on every install and no tar.gz association; the others have tar.
  const archiveName = `${name}.${windows ? "zip" : "tar.gz"}`
  const archivePath = path.join(releaseDir, archiveName)

  console.log(`Building ${name}...`)

  await fs.promises.mkdir(outDir, { recursive: true })

  // Where a compiled executable mounts its embedded files, per Bun's virtual filesystem.
  const bunfsRoot = windows ? "B:/~BUN/root/" : "/$bunfs/root/"
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

  if (windows) {
    const zip = new JSZip()
    zip.file(binary, await fs.promises.readFile(binaryPath))
    await fs.promises.writeFile(
      archivePath,
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    )
  } else {
    await fs.promises.chmod(binaryPath, 0o755)
    await $`tar -czf ${archivePath} -C ${outDir} ${binary}`
  }

  const hash = crypto.createHash("sha256")
  for await (const chunk of fs.createReadStream(archivePath)) hash.update(chunk)
  const sha256 = hash.digest("hex")
  artifacts[targetKey] = {
    path: archiveName,
    sha256,
    size: (await fs.promises.stat(archivePath)).size,
  }
  checksums.push(`${sha256}  ${archiveName}`)

  console.log(`  -> ${archivePath}`)
}

const manifest = { version, artifacts }
await Bun.file(path.join(releaseDir, "checksums.txt")).write(`${checksums.join("\n")}\n`)
await Bun.file(path.join(releaseDir, "manifest.json")).write(
  `${JSON.stringify(manifest, null, 2)}\n`,
)
await fs.promises.mkdir(path.join(publicDir, "releases"), { recursive: true })
await Bun.file(path.join(publicDir, "releases", "latest.txt")).write(`${version}\n`)
for (const installer of ["install.sh", "install.ps1"]) {
  await fs.promises.copyFile(path.join(root, "scripts", installer), path.join(publicDir, installer))
}

console.log("Done.")
