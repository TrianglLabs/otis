import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { HOSTED_PROVIDER_INFO, HOSTED_PROVIDERS } from "../inference/types.js"

export function localConfigDirectory() {
  return platformDirectory("config")
}

export function localDataDirectory() {
  return platformDirectory("data")
}

export function llamaBinaryDirectory(releaseTag: string) {
  return join(localDataDirectory(), "llama", "bin", releaseTag)
}

export function llamaModelCacheDirectory() {
  return join(localDataDirectory(), "llama", "models")
}

/** One record per owning Otis process, so a crashed Otis's orphan is reaped on the next start. */
export function llamaServerRecordsDirectory() {
  return join(localDataDirectory(), "llama", "servers")
}

function platformDirectory(kind: "config" | "data") {
  const otisHome = process.env.OTIS_HOME?.trim()
  if (otisHome) return resolve(otisHome)
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "otis")
  if (process.platform === "win32") {
    // Configuration roams with the profile; sessions, models and runtimes are machine-bound and
    // run to many gigabytes, so they stay in the local profile.
    const [variable, fallback] =
      kind === "config" ? ["APPDATA", "Roaming"] : ["LOCALAPPDATA", "Local"]
    return join(process.env[variable]?.trim() || join(homedir(), "AppData", fallback), "otis")
  }
  const [variable, ...fallback] =
    kind === "config" ? ["XDG_CONFIG_HOME", ".config"] : ["XDG_DATA_HOME", ".local", "share"]
  const xdg = process.env[variable]?.trim()
  return xdg ? join(xdg, "otis") : join(homedir(), ...fallback, "otis")
}

export function childProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env }
  for (const provider of HOSTED_PROVIDERS) delete childEnv[HOSTED_PROVIDER_INFO[provider].keyEnv]
  return childEnv
}

/**
 * Windows' own bsdtar, which reads zip archives and `C:` paths; Git for Windows puts a GNU tar on
 * the PATH that does neither. Elsewhere the system tar.
 */
export function tarExecutable() {
  return process.platform === "win32" ? windowsSystemExecutable("tar.exe") : "tar"
}

function windowsSystemExecutable(name: string) {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name)
}

/** The first `name` in PATH's directories; undefined when none has it. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env) {
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, name))
    .find((candidate) => existsSync(candidate))
}

let windowsBash: string | undefined

/**
 * The shell that runs the agent's commands, as `command -lc <script>`: the login shell on POSIX,
 * Git for Windows' bash on Windows, where the tool's contract (a POSIX shell with coreutils)
 * has no native equivalent. Looked up once; a missing Git for Windows is reported to the model.
 */
export function shellCommand(env: NodeJS.ProcessEnv = process.env) {
  if (process.platform !== "win32") return { command: env.SHELL || "/bin/sh", args: ["-lc"] }
  if (!windowsBash) {
    const roots = [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      join(env.LOCALAPPDATA ?? "", "Programs"),
    ]
    windowsBash = roots
      .filter((root): root is string => Boolean(root))
      .map((root) => join(root, "Git", "bin", "bash.exe"))
      .find((candidate) => existsSync(candidate))
    // System32 holds the WSL launcher, which is not a shell for Windows paths.
    const onPath = windowsBash ? undefined : findOnPath("bash.exe", env)
    if (onPath && !onPath.toLowerCase().includes("\\system32\\")) windowsBash = onPath
  }
  if (!windowsBash)
    throw new Error(
      "Shell commands on Windows run through Git Bash. Install Git for Windows " +
        "(https://git-scm.com/download/win) and restart Otis.",
    )
  return { command: windowsBash, args: ["-lc"] }
}

/**
 * Ends a command and everything it started: the process group on POSIX, where the child was
 * spawned detached as its own group leader; the process tree on Windows, which has no groups and
 * no graceful signal for console processes, so both signals end it at once.
 */
export function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return
  if (process.platform === "win32") {
    spawn(windowsSystemExecutable("taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => child.kill())
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return
    try {
      child.kill(signal)
    } catch {
      // The process may have exited between group and direct termination.
    }
  }
}
