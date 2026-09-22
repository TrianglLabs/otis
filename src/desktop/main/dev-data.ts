import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { cloneLocalGguf } from "../../inference/gguf-cache.js"
import { LOCAL_MODELS, localModelPackings } from "../../inference/local-catalog.js"
import { initializeLocalSettings } from "../../local/settings.js"

/** Development has its own persistent profile so it can run beside the installed app. */
type DevDataSandbox = {
  /** Electron's userData: the single-instance lock, caches, window state. */
  userData: string
  /**
   * `OTIS_HOME` for everything Otis persists; an explicit `OTIS_HOME` wins over the sandbox
   * default.
   */
  otisHome: string
}

/**
 * Defaults to the platform's app-data directory, independent of the checkout or working directory.
 * Explicit overrides remain available for isolated test runs. Packaged builds keep their existing
 * profile. The caller applies these paths before the single-instance lock and application
 * initialization.
 */
export function resolveDevData(env: {
  packaged: boolean
  appData: string
  otisDevUserData: string | undefined
  otisHome: string | undefined
}): DevDataSandbox | undefined {
  if (env.packaged) return undefined
  const userData = resolve(cleanPath(env.otisDevUserData) ?? join(env.appData, "otis-dev"))
  return { userData, otisHome: resolve(cleanPath(env.otisHome) ?? userData) }
}

function cleanPath(value: string | undefined) {
  return value?.trim() || undefined
}

/**
 * Explicit test profiles opt out so they never inherit the developer's credentials or large files.
 */
export function shouldInitializeDevProfile(env: { otisDevUserData?: string; otisHome?: string }) {
  return !cleanPath(env.otisDevUserData) && !cleanPath(env.otisHome)
}

/** Called after the development single-instance lock, before any settings or models are loaded. */
export async function initializeDevProfile(options: {
  sourceConfigDirectory: string
  sourceDataDirectory: string
  otisHome: string
}) {
  const marker = join(options.otisHome, ".installed-profile-imported")
  try {
    await readFile(marker)
    return
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  await mkdir(options.otisHome, { recursive: true, mode: 0o700 })
  await initializeLocalSettings(join(options.sourceConfigDirectory, "config.json"), {
    file: join(options.otisHome, "config.json"),
  })
  for (const model of LOCAL_MODELS) {
    for (const packing of localModelPackings(model)) {
      await cloneLocalGguf(
        packing,
        join(options.sourceDataDirectory, "llama"),
        join(options.otisHome, "llama"),
      )
    }
  }
  // Do not re-import settings or resurrect models deliberately deleted from the dev profile on
  // later launches.
  await writeFile(marker, "1\n", { mode: 0o600, flag: "wx" })
}
