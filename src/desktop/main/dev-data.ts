import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { cloneLocalGguf } from "../../inference/gguf-cache.js"
import { LOCAL_MODELS, localModelPackings } from "../../inference/local-catalog.js"
import { initializeLocalSettings } from "../../local/settings.js"
import { isNotFoundError } from "../../storage/session-events.js"

/**
 * The installed profile's history: sessions with their workspaces, published documents and project
 * memory, and the global memory.
 */
const HISTORY = ["sessions", "memory"]

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

/**
 * Called after the development single-instance lock, before any settings or models are loaded.
 * The first launch imports the installed setup and history; later ones import only new history,
 * and only when asked to refresh.
 */
export async function initializeDevProfile(options: {
  sourceConfigDirectory: string
  sourceDataDirectory: string
  otisHome: string
  refresh?: boolean
}) {
  const marker = join(options.otisHome, ".installed-profile-imported")
  const imported = await readFile(marker).then(
    () => true,
    (error: unknown) => {
      if (isNotFoundError(error)) return false
      throw error
    },
  )
  if (imported) {
    if (options.refresh) await importHistory(options.sourceDataDirectory, options.otisHome)
    return
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
  await importHistory(options.sourceDataDirectory, options.otisHome)
  // Do not re-import settings or resurrect models deliberately deleted from the dev profile on
  // later launches.
  await writeFile(marker, "1\n", { mode: 0o600, flag: "wx" })
}

/**
 * Copies the installed profile's history into the development profile, one way. A file missing
 * from development is copied; one present is replaced only while it is an untouched earlier copy
 * of the installed file, as an append-only session log is of its later self, so nothing written in
 * development is lost. Nothing is deleted, and the installed profile is only read.
 */
export async function importHistory(sourceDataDirectory: string, otisHome: string) {
  const copy = async (from: string, to: string) => {
    const entries = await readdir(from, { withFileTypes: true }).catch((error: unknown) => {
      if (isNotFoundError(error)) return []
      throw error
    })
    for (const entry of entries) {
      const source = join(from, entry.name)
      const target = join(to, entry.name)
      if (entry.isDirectory()) await copy(source, target)
      if (!entry.isFile()) continue
      const size = (await stat(source)).size
      const current = await stat(target).catch((error: unknown) => {
        if (isNotFoundError(error)) return undefined
        throw error
      })
      // At least as long: the same file, or one development has written to itself.
      if (current && current.size >= size) continue
      const content = await readFile(source)
      if (current && !content.subarray(0, current.size).equals(await readFile(target))) continue
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      // A whole file lands at once, so the app never reads half a session.
      const partial = `${target}.importing`
      await writeFile(partial, content, { mode: 0o600 })
      await rename(partial, target)
    }
  }
  for (const name of HISTORY) await copy(join(sourceDataDirectory, name), join(otisHome, name))
}
