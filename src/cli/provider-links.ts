import { spawn } from "node:child_process"

export const FIREWORKS_KEY_URL = "https://app.fireworks.ai/api-keys"

type OpenFireworksKeyPageOptions = {
  platform?: NodeJS.Platform
  launch?: (command: string, args: string[]) => Promise<void>
}

export async function openFireworksKeyPage(
  options: OpenFireworksKeyPageOptions = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform
  const executable =
    platform === "darwin" ? "/usr/bin/open" : platform === "linux" ? "xdg-open" : undefined
  if (!executable) return false

  try {
    await (options.launch ?? launchDetached)(executable, [FIREWORKS_KEY_URL])
    return true
  } catch {
    return false
  }
}

function launchDetached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}
