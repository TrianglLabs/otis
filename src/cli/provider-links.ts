import { spawn } from "node:child_process"
import { HOSTED_PROVIDER_INFO, type HostedProvider } from "../inference/types.js"

type OpenKeyPageOptions = {
  platform?: NodeJS.Platform
  launch?: (command: string, args: string[]) => Promise<void>
}

/** Opens the provider's API key page in the user's browser; false when there is no launcher. */
export async function openHostedKeyPage(
  provider: HostedProvider,
  options: OpenKeyPageOptions = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform
  const executable =
    platform === "darwin" ? "/usr/bin/open" : platform === "linux" ? "xdg-open" : undefined
  if (!executable) return false

  try {
    await (options.launch ?? launchDetached)(executable, [HOSTED_PROVIDER_INFO[provider].keyURL])
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
