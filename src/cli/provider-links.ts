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
  const url = HOSTED_PROVIDER_INFO[provider].keyURL
  // On Windows, url.dll's handler is ShellExecute for a URL: the default browser, no shell quoting.
  const launcher: [string, string[]] | undefined =
    platform === "darwin"
      ? ["/usr/bin/open", [url]]
      : platform === "linux"
        ? ["xdg-open", [url]]
        : platform === "win32"
          ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
          : undefined
  if (!launcher) return false

  try {
    await (options.launch ?? launchDetached)(...launcher)
    return true
  } catch {
    return false
  }
}

function launchDetached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}
