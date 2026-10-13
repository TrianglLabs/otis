import { spawn } from "node:child_process"

/**
 * Holds off idle system sleep through the platform's own helper: `caffeinate` on macOS, a
 * systemd sleep inhibitor on Linux, and on Windows a PowerShell host that sets the thread
 * execution state the Win32 API offers for exactly this. Displays still sleep and a closed lid
 * still suspends. The helper watches this process, so a crash cannot leave the machine unable to
 * sleep. Returns the release, or undefined on a platform without a helper; a helper that is
 * missing changes nothing.
 */
export function holdAwake(platform: NodeJS.Platform = process.platform, pid = process.pid) {
  const command =
    platform === "darwin"
      ? ["caffeinate", "-i", "-w", String(pid)]
      : platform === "linux"
        ? [
            "systemd-inhibit",
            "--what=sleep",
            "--mode=block",
            "--who=Otis",
            "--why=Otis is working",
            "tail",
            `--pid=${pid}`,
            "-f",
            "/dev/null",
          ]
        : platform === "win32"
          ? [
              "powershell.exe",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by the thread that then waits on us;
              // Windows clears it when that thread ends.
              "Add-Type -Namespace Otis -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'; " +
                `[Otis.Power]::SetThreadExecutionState(0x80000001) | Out-Null; Wait-Process -Id ${pid}`,
            ]
          : undefined
  if (!command) return undefined
  // Its own process group, so the release ends the inhibitor and the watcher it runs together.
  const child = spawn(command[0], command.slice(1), {
    detached: platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  })
  child.on("error", () => undefined)
  child.unref()
  return () => {
    if (child.pid === undefined || child.exitCode !== null) return
    try {
      if (platform === "win32") child.kill()
      else process.kill(-child.pid)
    } catch {}
  }
}
