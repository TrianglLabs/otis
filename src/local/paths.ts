import { homedir } from "node:os"
import { join, resolve } from "node:path"

export function localConfigDirectory() {
  const otisHome = cleanEnvPath(process.env.OTIS_HOME)
  if (otisHome) return resolve(otisHome)
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "otis")

  if (process.platform === "win32") {
    const appData = cleanEnvPath(process.env.APPDATA)
    if (appData) return join(appData, "otis")
  }

  const xdgConfigHome = cleanEnvPath(process.env.XDG_CONFIG_HOME)
  return xdgConfigHome ? join(xdgConfigHome, "otis") : join(homedir(), ".config", "otis")
}

export function localDataDirectory() {
  const otisHome = cleanEnvPath(process.env.OTIS_HOME)
  if (otisHome) return resolve(otisHome)
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "otis")

  if (process.platform === "win32") {
    const appData = cleanEnvPath(process.env.APPDATA)
    if (appData) return join(appData, "otis")
  }

  const xdgDataHome = cleanEnvPath(process.env.XDG_DATA_HOME)
  return xdgDataHome ? join(xdgDataHome, "otis") : join(homedir(), ".local", "share", "otis")
}

export function llamaRuntimeDirectory() {
  return join(localDataDirectory(), "llama")
}

export function llamaBinaryDirectory(releaseTag: string) {
  return join(llamaRuntimeDirectory(), "bin", releaseTag)
}

export function llamaModelCacheDirectory() {
  return join(llamaRuntimeDirectory(), "models")
}

function cleanEnvPath(value: string | undefined) {
  return value?.trim() || undefined
}
