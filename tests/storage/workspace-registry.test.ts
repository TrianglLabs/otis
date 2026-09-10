import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createSession, defaultSessionDirectory, sessionRootDirectory } from "../../src/storage/index.js"
import {
  listWorkspaceSessionDirs,
  readWorkspacePath,
  registerWorkspacePath,
} from "../../src/storage/workspace-registry.js"
import { useOtisHome } from "../app/support/otis-home.js"

const isolate = useOtisHome()

describe("workspace registry", () => {
  it("round-trips a registered workspace path", async () => {
    const home = await isolate()
    const dir = join(home, "sessions", "proj-0123456789ab")
    await registerWorkspacePath(dir, "/Users/dev/proj")
    expect(await readWorkspacePath(dir)).toBe("/Users/dev/proj")
  })

  it("reports undefined for missing or corrupt markers instead of throwing", async () => {
    const home = await isolate()
    const dir = join(home, "sessions", "proj-0123456789ab")
    expect(await readWorkspacePath(dir)).toBeUndefined()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "workspace.json"), "{ not json")
    expect(await readWorkspacePath(dir)).toBeUndefined()
    await writeFile(join(dir, "workspace.json"), JSON.stringify({ path: 42 }))
    expect(await readWorkspacePath(dir)).toBeUndefined()
  })

  it("lists session directories with and without registered paths", async () => {
    const home = await isolate()
    const root = sessionRootDirectory()
    await mkdir(join(root, "known-aaaaaaaaaaaa"), { recursive: true })
    await mkdir(join(root, "legacy-bbbbbbbbbbbb"), { recursive: true })
    await registerWorkspacePath(join(root, "known-aaaaaaaaaaaa"), "/work/known")

    const dirs = await listWorkspaceSessionDirs()
    expect(dirs).toHaveLength(2)
    const known = dirs.find((entry) => entry.dirName === "known-aaaaaaaaaaaa")
    const legacy = dirs.find((entry) => entry.dirName === "legacy-bbbbbbbbbbbb")
    expect(known?.workspacePath).toBe("/work/known")
    expect(legacy?.workspacePath).toBeUndefined()
    expect(home).toBeTruthy()
  })

  it("registers the workspace marker when a session is opened from a known cwd", async () => {
    await isolate()
    const cwd = "/Users/dev/brand-new-project"
    await createSession({ cwd })
    expect(await readWorkspacePath(defaultSessionDirectory(cwd))).toBe(cwd)
  })

  it("keeps marker writes private", async () => {
    const home = await isolate()
    const dir = join(home, "sessions", "proj-0123456789ab")
    await registerWorkspacePath(dir, "/work/proj")
    if (process.platform === "win32") return
    const { stat } = await import("node:fs/promises")
    const mode = (await stat(join(dir, "workspace.json"))).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe("workspace recovery", () => {
  it("recovers an unregistered dir whose name hash matches a seed folder, and persists the marker", async () => {
    const home = await isolate()
    const workspace = join(home, "projects", "otis")
    await mkdir(workspace, { recursive: true })
    // Pre-registration history: a session dir named for the workspace but no workspace.json marker.
    const dirName = join(defaultSessionDirectory(workspace)).split("/").pop() as string
    await mkdir(join(sessionRootDirectory(), dirName), { recursive: true })

    const dirs = await listWorkspaceSessionDirs([join(home, "unrelated")])
    expect(dirs.find((entry) => entry.dirName === dirName)?.workspacePath).toBeUndefined()

    const recovered = await listWorkspaceSessionDirs([workspace])
    expect(recovered.find((entry) => entry.dirName === dirName)?.workspacePath).toBe(workspace)
    // Persisted: recovery does not depend on the seed being offered again.
    expect(await readWorkspacePath(join(sessionRootDirectory(), dirName))).toBe(workspace)
  })

  it("recovers via an ancestor of the seed — sessions from a parent folder run", async () => {
    const home = await isolate()
    const parent = join(home, "Projects.nosync")
    const workspace = join(parent, "otis")
    await mkdir(workspace, { recursive: true })
    const dirName = join(defaultSessionDirectory(parent)).split("/").pop() as string
    await mkdir(join(sessionRootDirectory(), dirName), { recursive: true })

    const recovered = await listWorkspaceSessionDirs([workspace])
    expect(recovered.find((entry) => entry.dirName === dirName)?.workspacePath).toBe(parent)
  })

  it("leaves genuinely unknown dirs unregistered", async () => {
    const home = await isolate()
    await mkdir(join(sessionRootDirectory(), "elsewhere-deadbeef00aa"), { recursive: true })
    const recovered = await listWorkspaceSessionDirs([join(home, "projects", "otis")])
    expect(recovered.find((entry) => entry.dirName === "elsewhere-deadbeef00aa")?.workspacePath).toBeUndefined()
  })
})
