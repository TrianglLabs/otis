import { homedir } from "node:os"
import { join, resolve } from "node:path"

export function localConfigDirectory() {
  return platformDirectory("XDG_CONFIG_HOME", ".config")
}

export function localDataDirectory() {
  return platformDirectory("XDG_DATA_HOME", ".local", "share")
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

function platformDirectory(xdgVariable: string, ...fallback: string[]) {
  const otisHome = process.env.OTIS_HOME?.trim()
  if (otisHome) return resolve(otisHome)
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "otis")
  const appData = process.env.APPDATA?.trim()
  if (process.platform === "win32" && appData) return join(appData, "otis")
  const xdg = process.env[xdgVariable]?.trim()
  return xdg ? join(xdg, "otis") : join(homedir(), ...fallback, "otis")
}

export function childProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env }
  delete childEnv.FIREWORKS_API_KEY
  return childEnv
}
