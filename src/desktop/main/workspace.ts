import { homedir } from "node:os"
import { join, parse, resolve } from "node:path"

/**
 * Where the desktop app works. A terminal launch keeps the shell's cwd; a Finder/Dock launch reports "/" as the
 * cwd, which would scope sessions — and the agent's file tools — to the filesystem root. GUI launches resume the
 * last workspace used in the GUI; first run gets a dedicated ~/Otis workspace, created by the caller.
 */
export function resolveWorkspaceCwd(
  env: NodeJS.ProcessEnv,
  cwd: string,
  home = homedir(),
  lastWorkspace?: string,
): string {
  if (env.OTIS_WORKSPACE) return env.OTIS_WORKSPACE
  if (parse(resolve(cwd)).root !== resolve(cwd)) return cwd
  return lastWorkspace ?? join(home, "Otis")
}

export type WorkspaceRecovery = {
  /** Explains the failure and asks whether to pick a replacement folder or stop. */
  choose(title: string, detail: string): Promise<"pick" | "quit">
  /** A native directory picker; undefined when the user cancels. */
  pickFolder(): Promise<string | undefined>
  mkdir(path: string): Promise<unknown>
  /** Final, unrecoverable failure message before the caller stops startup. */
  showError(title: string, detail: string): void
}

/**
 * Recovery when the workspace can't be created. Never silently substitutes another directory: the workspace owns
 * session history and tool scope, so the user either picks a replacement explicitly or the app stops.
 */
export async function recoverWorkspaceCwd(
  cwd: string,
  cause: unknown,
  recovery: WorkspaceRecovery,
): Promise<string | undefined> {
  const reason = cause instanceof Error ? cause.message : String(cause)
  const action = await recovery.choose(
    "Otis couldn't use its workspace",
    `${cwd}: ${reason}\n\nPick a different folder, or quit and fix the path.`,
  )
  if (action === "quit") return undefined
  const picked = await recovery.pickFolder()
  if (!picked) return undefined
  try {
    await recovery.mkdir(picked)
    return picked
  } catch (pickCause) {
    const pickReason = pickCause instanceof Error ? pickCause.message : String(pickCause)
    recovery.showError("Otis couldn't use that folder", `${picked}: ${pickReason}`)
    return undefined
  }
}
