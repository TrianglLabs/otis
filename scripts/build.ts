#!/usr/bin/env bun

/**
 * Release archives of the `otis` command: the Rust terminal UI with the compiled TypeScript runtime
 * embedded, one file per platform. `--target os-arch` builds one platform's archive (repeatable;
 * this machine's by default), since the UI compiles natively on each platform's runner.
 * `--assemble` writes the checksums, manifest, and installers for the archives already present.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { $ } from "bun"
import JSZip from "jszip"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
process.chdir(root)

const { version } = await Bun.file(path.join(root, "package.json")).json()
const publicDir = path.join("dist", "public")
const releaseDir = path.join(publicDir, "releases", `v${version}`)

// Bun compiles Windows for x64 only; Windows on Arm runs that build through its x64 emulation.
// Linux links musl statically, so the UI runs on any distribution the runtime does.
const TARGETS: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "windows-x64": "x86_64-pc-windows-msvc",
}

const args = process.argv.slice(2)
const assembleOnly = args.includes("--assemble")
const requested = args.flatMap((arg, index) => (args[index - 1] === "--target" ? [arg] : []))
const host = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const targets = assembleOnly ? [] : requested.length > 0 ? requested : [host]
const unknown = targets.find((target) => !TARGETS[target])
if (unknown) throw new Error(`Unknown target ${unknown}: use one of ${Object.keys(TARGETS)}`)

if (!assembleOnly) await fs.promises.rm("dist", { recursive: true, force: true })
await fs.promises.mkdir(releaseDir, { recursive: true })

for (const target of targets) {
  const windows = target.startsWith("windows-")
  const name = `otis-${target}`
  const outDir = path.resolve("dist", "build", name)
  const suffix = windows ? ".exe" : ""
  const runtime = path.join(outDir, `otis-runtime${suffix}`)
  const binary = `otis${suffix}`
  console.log(`Building ${name}...`)
  await fs.promises.mkdir(outDir, { recursive: true })

  const result = await Bun.build({
    entrypoints: ["./src/cli/index.ts"],
    compile: { target: `bun-${target}` as Bun.Build.Target, outfile: runtime },
    sourcemap: "none",
    define: { "process.env.OTIS_VERSION": JSON.stringify(version) },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`Runtime build failed for ${name}`)
  }

  const triple = TARGETS[target]
  await $`cargo build --release --locked --manifest-path tui/Cargo.toml --target ${triple}`.env({
    ...process.env,
    OTIS_RUNTIME_PAYLOAD: runtime,
  })
  const binaryPath = path.join(outDir, binary)
  await fs.promises.copyFile(path.join("tui", "target", triple, "release", binary), binaryPath)

  // Windows has a zip reader on every install and no tar.gz association; the others have tar.
  const archivePath = path.join(releaseDir, `${name}.${windows ? "zip" : "tar.gz"}`)
  if (windows) {
    const zip = new JSZip()
    zip.file(binary, await fs.promises.readFile(binaryPath))
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
    await fs.promises.writeFile(archivePath, bytes)
  } else {
    await fs.promises.chmod(binaryPath, 0o755)
    await $`tar -czf ${archivePath} -C ${outDir} ${binary}`
  }
  console.log(`  -> ${archivePath}`)
}

// Every archive in the release folder, built here or gathered from the other platforms' runners.
const artifacts: Record<string, { path: string; sha256: string; size: number }> = {}
const checksums: string[] = []
for (const file of (await fs.promises.readdir(releaseDir)).sort()) {
  const target = /^otis-(.+)\.(?:tar\.gz|zip)$/.exec(file)?.[1]
  if (!target || !TARGETS[target]) continue
  const archivePath = path.join(releaseDir, file)
  const hash = crypto.createHash("sha256")
  for await (const chunk of fs.createReadStream(archivePath)) hash.update(chunk)
  const sha256 = hash.digest("hex")
  artifacts[target] = { path: file, sha256, size: (await fs.promises.stat(archivePath)).size }
  checksums.push(`${sha256}  ${file}`)
}
if (checksums.length === 0) throw new Error(`No release archives in ${releaseDir}`)

await Bun.write(path.join(releaseDir, "checksums.txt"), `${checksums.join("\n")}\n`)
await Bun.write(
  path.join(releaseDir, "manifest.json"),
  `${JSON.stringify({ version, artifacts }, null, 2)}\n`,
)
await Bun.write(path.join(publicDir, "releases", "latest.txt"), `${version}\n`)
for (const installer of ["install.sh", "install.ps1"]) {
  await fs.promises.copyFile(path.join("scripts", installer), path.join(publicDir, installer))
}

console.log("Done.")
