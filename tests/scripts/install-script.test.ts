import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip from "jszip"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const windows = process.platform === "win32"
const arch = process.arch === "arm64" ? "arm64" : "x64"
const os = process.platform === "darwin" ? "darwin" : "linux"
const artifact = windows ? "otis-windows-x64.zip" : `otis-${os}-${arch}.tar.gz`

let releases: string
let baseUrl: string
const server = createServer((request, response) => {
  const file = request.url?.startsWith("/latest/download/latest.txt")
    ? "latest.txt"
    : request.url?.startsWith("/download/v0.0.1/")
      ? request.url.slice("/download/v0.0.1/".length)
      : undefined
  try {
    if (!file) throw new Error("not found")
    response.end(readFileSync(join(releases, file)))
  } catch {
    response.statusCode = 404
    response.end()
  }
})

/** A release on a local server: the binary archive for this platform, its checksum, the version. */
beforeAll(async () => {
  releases = mkdtempSync(join(tmpdir(), "otis-releases-"))
  if (windows) {
    const zip = new JSZip()
    zip.file("otis.exe", "MZ otis 0.0.1")
    writeFileSync(join(releases, artifact), await zip.generateAsync({ type: "nodebuffer" }))
  } else {
    writeFileSync(join(releases, "otis"), "#!/bin/sh\necho otis 0.0.1\n", { mode: 0o755 })
    spawnSync("tar", ["-czf", join(releases, artifact), "-C", releases, "otis"])
  }
  const digest = createHash("sha256")
    .update(readFileSync(join(releases, artifact)))
    .digest("hex")
  writeFileSync(join(releases, "checksums.txt"), `${digest}  ${artifact}\n`)
  writeFileSync(join(releases, "latest.txt"), "v0.0.1\n")
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no server address")
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(() => {
  server.close()
  rmSync(releases, { recursive: true, force: true })
})

// The release server answers on this worker's event loop, so the script must run asynchronously.
function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ status: number | null; stderr: string; stdout: string }>((resolve) => {
    const child = spawn(command, args, { windowsHide: true, env })
    let stderr = ""
    let stdout = ""
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
    })
    child.on("close", (status) => resolve({ status, stderr, stdout }))
  })
}

describe.skipIf(windows)("install.sh", () => {
  const script = join(import.meta.dirname, "../../scripts/install.sh")
  // Every run gets a home of its own, so no test touches the startup files of whoever runs it.
  const home = () => mkdtempSync(join(tmpdir(), "otis-home-"))
  const install = (installDir: string, env: NodeJS.ProcessEnv = {}, args: string[] = []) =>
    run("bash", [script, "--base-url", baseUrl, "--install-dir", installDir, ...args], {
      PATH: process.env.PATH,
      HOME: home(),
      SHELL: "/bin/sh",
      ...env,
    })
  const read = (path: string) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return undefined
    }
  }

  it("installs the verified terminal binary", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "otis-install-"))
    try {
      const result = await install(installDir)
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(installDir, "otis"), "utf8")).toContain("otis 0.0.1")
    } finally {
      rmSync(installDir, { recursive: true, force: true })
    }
  })

  it("puts the folder on PATH for new terminals of the user's shell, once", async () => {
    const userHome = home()
    const installDir = join(userHome, ".local", "bin")
    const line = 'export PATH="$HOME/.local/bin:$PATH"'
    try {
      const first = await install(installDir, { HOME: userHome, SHELL: "/bin/zsh" })
      expect(first.status, first.stderr).toBe(0)
      expect(first.stdout).toContain(`Added Otis to your PATH in ${join(userHome, ".zshrc")}`)
      expect(first.stdout).toContain(line)
      const again = await install(installDir, { HOME: userHome, SHELL: "/bin/zsh" })
      expect(again.status, again.stderr).toBe(0)
      expect(again.stdout).not.toContain("Added Otis to your PATH")
      expect(read(join(userHome, ".zshrc"))).toBe(
        `\n# >>> Otis installer >>>\n${line}\n# <<< Otis installer <<<\n`,
      )
    } finally {
      rmSync(userHome, { recursive: true, force: true })
    }
  })

  it.each([
    ["zsh with ZDOTDIR", { SHELL: "/usr/bin/zsh", ZDOTDIR: "zdot" }, "zdot/.zshrc"],
    ["bash", { SHELL: "/bin/bash" }, os === "darwin" ? ".bash_profile" : ".bashrc"],
    ["fish", { SHELL: "/usr/local/bin/fish" }, ".config/fish/conf.d/otis.fish"],
  ])("writes %s's own startup file", async (_, env, file) => {
    const userHome = home()
    const installDir = join(userHome, "bin")
    try {
      const zdotdir = "ZDOTDIR" in env ? { ZDOTDIR: join(userHome, env.ZDOTDIR) } : {}
      const result = await install(installDir, { ...env, ...zdotdir, HOME: userHome })
      expect(result.status, result.stderr).toBe(0)
      expect(read(join(userHome, file))).toContain(
        file.endsWith(".fish")
          ? 'contains -- "$HOME/bin" $PATH; or set -gx PATH "$HOME/bin" $PATH'
          : 'export PATH="$HOME/bin:$PATH"',
      )
    } finally {
      rmSync(userHome, { recursive: true, force: true })
    }
  })

  it.runIf(os === "darwin")("keeps a macOS bash user's .profile the file bash reads", async () => {
    const userHome = home()
    try {
      writeFileSync(join(userHome, ".profile"), "# mine\n")
      const result = await install(join(userHome, "bin"), { HOME: userHome, SHELL: "/bin/bash" })
      expect(result.status, result.stderr).toBe(0)
      expect(read(join(userHome, ".profile"))).toContain('export PATH="$HOME/bin:$PATH"')
      // A new .bash_profile would stop bash reading .profile at all.
      expect(read(join(userHome, ".bash_profile"))).toBeUndefined()
    } finally {
      rmSync(userHome, { recursive: true, force: true })
    }
  })

  it("leaves a file that already names the folder alone", async () => {
    const userHome = home()
    const installDir = join(userHome, "bin")
    try {
      writeFileSync(join(userHome, ".zshrc"), `path+=(${installDir})\n`)
      const result = await install(installDir, { HOME: userHome, SHELL: "/bin/zsh" })
      expect(result.status, result.stderr).toBe(0)
      expect(read(join(userHome, ".zshrc"))).toBe(`path+=(${installDir})\n`)
    } finally {
      rmSync(userHome, { recursive: true, force: true })
    }
  })

  it.each([
    ["the opt-out variable", { OTIS_NO_MODIFY_PATH: "1", SHELL: "/bin/zsh" }, []],
    ["--no-modify-path", { SHELL: "/bin/zsh" }, ["--no-modify-path"]],
    ["a shell it does not know", { SHELL: "/usr/bin/nu" }, []],
  ])("only says what to run with %s", async (_, env, args) => {
    const userHome = home()
    const installDir = join(userHome, "bin")
    try {
      const result = await install(installDir, { ...env, HOME: userHome }, args)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain(`Add Otis to your PATH:\n  export PATH="${installDir}:$PATH"`)
      expect(read(join(userHome, ".zshrc"))).toBeUndefined()
    } finally {
      rmSync(userHome, { recursive: true, force: true })
    }
  })

  it("changes nothing when the folder is already on PATH", async () => {
    const userHome = home()
    const installDir = join(userHome, "bin")
    try {
      mkdirSync(installDir)
      const result = await install(installDir, {
        HOME: userHome,
        SHELL: "/bin/zsh",
        PATH: `${installDir}:${process.env.PATH}`,
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).not.toContain("PATH")
      expect(read(join(userHome, ".zshrc"))).toBeUndefined()
    } finally {
      rmSync(userHome, { recursive: true, force: true })
    }
  })

  it("refuses to overwrite the desktop AppImage installed under the same name", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "otis-install-"))
    try {
      // ELF header with the AppImage type-2 magic at offset 8.
      const appImage = Buffer.concat([
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
        Buffer.from("AI\u0002"),
        Buffer.alloc(64),
      ])
      writeFileSync(join(installDir, "otis"), appImage, { mode: 0o755 })
      const result = await install(installDir)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("is the Otis desktop AppImage")
      expect(result.stderr).toContain(`${installDir}/otis-desktop`)
      expect(readFileSync(join(installDir, "otis"))).toEqual(appImage)
    } finally {
      rmSync(installDir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!windows)("install.ps1", () => {
  const script = join(import.meta.dirname, "../../scripts/install.ps1")
  // Opted out of PATH changes, so a run never adds a temporary folder to the user's own Path.
  const install = (installDir: string) =>
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-BaseUrl",
        baseUrl,
        "-InstallDir",
        installDir,
      ],
      { ...process.env, OTIS_NO_MODIFY_PATH: "1" },
    )

  it("installs the verified executable and tells the user how to put it on PATH", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "otis-install-"))
    try {
      const result = await install(installDir)
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(installDir, "otis.exe"), "utf8")).toBe("MZ otis 0.0.1")
      expect(result.stdout).toContain(`Otis installed to ${join(installDir, "otis.exe")}`)
      expect(result.stdout).toContain("Add Otis to your PATH, then open a new terminal:")
      expect(result.stdout).toContain(installDir)
    } finally {
      rmSync(installDir, { recursive: true, force: true })
    }
  })

  it("moves a previous executable aside instead of overwriting it, then removes it", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "otis-install-"))
    try {
      writeFileSync(join(installDir, "otis.exe"), "old")
      const result = await install(installDir)
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(installDir, "otis.exe"), "utf8")).toBe("MZ otis 0.0.1")
      expect(() => readFileSync(join(installDir, ".otis-previous.exe"))).toThrow()
    } finally {
      rmSync(installDir, { recursive: true, force: true })
    }
  })

  it("refuses an archive whose checksum does not match", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "otis-install-"))
    const checksums = readFileSync(join(releases, "checksums.txt"), "utf8")
    writeFileSync(join(releases, "checksums.txt"), `${"0".repeat(64)}  ${artifact}\n`)
    try {
      const result = await install(installDir)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("Checksum verification failed")
      expect(() => readFileSync(join(installDir, "otis.exe"))).toThrow()
    } finally {
      writeFileSync(join(releases, "checksums.txt"), checksums)
      rmSync(installDir, { recursive: true, force: true })
    }
  })
})
