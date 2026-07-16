import { spawn } from "node:child_process"
import { platform } from "node:os"

let resolved: Promise<string[] | undefined> | undefined

function resolveCommand(): Promise<string[] | undefined> {
  if (resolved) return resolved
  resolved = doResolve()
  return resolved
}

async function doResolve(): Promise<string[] | undefined> {
  const os = platform()

  if (os === "darwin") {
    if (await exists("pbcopy")) return ["pbcopy"]
  }

  if (os === "linux") {
    if (process.env.WAYLAND_DISPLAY && (await exists("wl-copy"))) return ["wl-copy"]
    if (await exists("xclip")) return ["xclip", "-selection", "clipboard"]
    if (await exists("xsel")) return ["xsel", "--clipboard", "--input"]
  }

  if (os === "win32") {
    if (await exists("powershell.exe")) {
      return [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ]
    }
  }

  return undefined
}

async function exists(name: string): Promise<boolean> {
  const finder = platform() === "win32" ? "where" : "which"
  return new Promise((resolve) => {
    const child = spawn(finder, [name], { stdio: "ignore" })
    child.on("error", () => resolve(false))
    child.on("exit", (code) => resolve(code === 0))
  })
}

/**
 * Copy text to the system clipboard using a native platform utility.
 * Unlike OSC 52, native utilities have no size limit.
 * The command is resolved once and cached. Returns false if no
 * native clipboard tool is available (caller should rely on OSC 52).
 */
export async function copyToClipboardNative(text: string): Promise<boolean> {
  const cmd = await resolveCommand()
  if (!cmd) return false

  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => resolve(false))
    child.on("exit", (code) => resolve(code === 0))
    child.stdin?.on("error", () => resolve(false))
    child.stdin?.end(text)
  })
}
