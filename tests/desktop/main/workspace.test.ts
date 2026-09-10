import { describe, expect, it } from "vitest"
import {
  recoverWorkspaceCwd,
  resolveWorkspaceCwd,
  type WorkspaceRecovery,
} from "../../../src/desktop/main/workspace.js"

describe("resolveWorkspaceCwd", () => {
  it("keeps the shell's cwd for terminal launches", () => {
    expect(resolveWorkspaceCwd({}, "/Users/nik/code", "/Users/nik")).toBe("/Users/nik/code")
  })

  it("falls back to ~/Otis when launched from Finder (cwd is the filesystem root)", () => {
    expect(resolveWorkspaceCwd({}, "/", "/Users/nik")).toBe("/Users/nik/Otis")
  })

  it("honors OTIS_WORKSPACE over everything, including root", () => {
    expect(resolveWorkspaceCwd({ OTIS_WORKSPACE: "/tmp/picked" }, "/", "/Users/nik")).toBe("/tmp/picked")
    expect(resolveWorkspaceCwd({ OTIS_WORKSPACE: "/tmp/picked" }, "/Users/nik/code", "/Users/nik")).toBe("/tmp/picked")
  })
})

describe("recoverWorkspaceCwd", () => {
  function recovery(overrides: Partial<WorkspaceRecovery> = {}) {
    return {
      choose: async () => "quit" as const,
      pickFolder: async () => undefined,
      mkdir: async () => {},
      showError: () => {},
      ...overrides,
    }
  }

  it("stops (undefined) when the user quits instead of picking — no scope change behind their back", async () => {
    let picked = false
    const result = await recoverWorkspaceCwd(
      "/explicit/dir",
      new Error("EACCES"),
      recovery({
        choose: async () => "quit",
        pickFolder: async () => {
          picked = true
          return "/other"
        },
      }),
    )
    expect(result).toBeUndefined()
    expect(picked).toBe(false)
  })

  it("uses the folder the user explicitly picked, creating it first", async () => {
    const made: string[] = []
    const result = await recoverWorkspaceCwd(
      "/Users/nik/Otis",
      new Error("EEXIST: file already exists"),
      recovery({
        choose: async () => "pick" as const,
        pickFolder: async () => "/Users/nik/Projects",
        mkdir: async (path: string) => {
          made.push(path)
        },
      }),
    )
    expect(result).toBe("/Users/nik/Projects")
    expect(made).toEqual(["/Users/nik/Projects"])
  })

  it("stops when the folder picker is cancelled", async () => {
    const result = await recoverWorkspaceCwd(
      "/Users/nik/Otis",
      new Error("EEXIST"),
      recovery({ choose: async () => "pick" as const }),
    )
    expect(result).toBeUndefined()
  })

  it("shows a final error and stops when the picked folder cannot be created either", async () => {
    let shown = ""
    const result = await recoverWorkspaceCwd(
      "/Users/nik/Otis",
      new Error("EEXIST"),
      recovery({
        choose: async () => "pick" as const,
        pickFolder: async () => "/protected/dir",
        mkdir: async () => {
          throw new Error("EPERM")
        },
        showError: (title, detail) => {
          shown = `${title} ${detail}`
        },
      }),
    )
    expect(result).toBeUndefined()
    expect(shown).toContain("/protected/dir")
    expect(shown).toContain("EPERM")
  })
})
