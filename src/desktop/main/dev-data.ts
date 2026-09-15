/**
 * Dev affordance: `OTIS_DEV_USER_DATA` points a development build at its own sandbox so it can run beside the
 * installed app. Electron state (the single-instance lock, caches, window state) follows the sandbox as userData,
 * and — unless an explicit `OTIS_HOME` shapes it differently — everything Otis persists does too, via the same
 * directory: settings, sessions, skills, and the llama runtime all key off `OTIS_HOME` (see src/local/paths.ts).
 * Without that default a dev build would still read and write the installed app's data.
 */
export type DevDataSandbox = {
  /** Electron's userData: the single-instance lock, caches, window state. */
  userData: string
  /** `OTIS_HOME` for everything Otis persists; an explicit `OTIS_HOME` wins over the sandbox default. */
  otisHome: string
}

/**
 * Resolves the dev sandbox from the environment, or undefined when the build is packaged or no sandbox is
 * configured. Pure: the caller owns the side effects (creating the directory, applying the Electron path and
 * the `OTIS_HOME` default). `src/local/paths.ts` reads `OTIS_HOME` lazily at each call, so applying the default
 * in the main entry's module scope is visible to every later consumer.
 */
export function resolveDevData(env: {
  packaged: boolean
  otisDevUserData: string | undefined
  otisHome: string | undefined
}): DevDataSandbox | undefined {
  if (env.packaged) return undefined
  const userData = cleanPath(env.otisDevUserData)
  if (!userData) return undefined
  return { userData, otisHome: cleanPath(env.otisHome) ?? userData }
}

function cleanPath(value: string | undefined) {
  return value?.trim() || undefined
}
