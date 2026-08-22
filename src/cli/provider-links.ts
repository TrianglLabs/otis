import { spawn } from "node:child_process"

export const FIREWORKS_KEY_URL = "https://app.fireworks.ai/api-keys"

type BrowserLauncher = (command: string, args: string[]) => Promise<void>

type OpenFireworksKeyPageOptions = {
  platform?: NodeJS.Platform
  launch?: BrowserLauncher
}

export async function openFireworksKeyPage(options: OpenFireworksKeyPageOptions = {}): Promise<boolean> {
  const command = browserCommand(options.platform ?? process.platform, FIREWORKS_KEY_URL)
  if (!command) return false

  try {
    await (options.launch ?? launchDetached)(command.executable, command.args)
    return true
  } catch {
    return false
  }
}

function browserCommand(platform: NodeJS.Platform, url: string) {
  if (platform === "darwin") return { executable: "/usr/bin/open", args: [url] }
  if (platform === "linux") return { executable: "xdg-open", args: [url] }
  return undefined
}

function launchDetached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" })
    let settled = false
    child.once("error", (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once("spawn", () => {
      if (settled) return
      settled = true
      child.unref()
      resolve()
    })
  })
}
