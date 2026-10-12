import { spawn } from "node:child_process"

/**
 * Holds off idle system sleep through the platform's own helper: `caffeinate` on macOS, a
 * systemd sleep inhibitor on Linux. Displays still sleep and a closed lid still suspends. The
 * helper watches this process, so a crash cannot leave the machine unable to sleep. Returns the
 * release, or undefined on a platform without a helper; a helper that is missing changes nothing.
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
        : undefined
  if (!command) return undefined
  // Its own process group, so the release ends the inhibitor and the watcher it runs together.
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: "ignore" })
  child.on("error", () => undefined)
  child.unref()
  return () => {
    if (child.pid === undefined || child.exitCode !== null) return
    try {
      process.kill(-child.pid)
    } catch {}
  }
}
