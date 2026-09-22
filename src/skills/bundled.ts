import { createHash, randomUUID } from "node:crypto"
import { link, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { localDataDirectory } from "../local/paths.js"
import documentScript from "./bundled/documents/document.py" with { type: "text" }
import pdfEditScript from "./bundled/documents/pdf_edit.py" with { type: "text" }
import requirements from "./bundled/documents/requirements.txt" with { type: "text" }
import instructions from "./bundled/documents/SKILL.md" with { type: "text" }
import specification from "./bundled/documents/spec.md" with { type: "text" }
import type { Skill } from "./catalog.js"

const resources: Readonly<Record<string, string>> = {
  "SKILL.md": instructions,
  "document.py": documentScript,
  "pdf_edit.py": pdfEditScript,
  "requirements.txt": requirements,
  "spec.md": specification,
}
const revision = createHash("sha256").update(JSON.stringify(resources)).digest("hex").slice(0, 20)

export function bundledSkills(dataDirectory = localDataDirectory()): Skill[] {
  const root = join(resolve(dataDirectory), "bundled-skills", revision, "documents")
  return [
    {
      name: "documents",
      description:
        "Create, adapt, convert, and verify PDF and DOCX deliverables, including resumes. Preserve existing design and requested formats.",
      root,
      instructionsPath: join(root, "SKILL.md"),
      bundled: true,
    },
  ]
}

/**
 * No installs or execution: loading a skill only exposes the exact helpers embedded in this
 * release.
 */
export async function materializeBundledSkill(skill: Skill) {
  const base = dirname(dirname(dirname(skill.root)))
  await mkdir(base, { recursive: true, mode: 0o700 })
  let root = await realpath(base)
  // Create each segment without following links so a swapped-in symlink cannot redirect the cache.
  for (const segment of ["bundled-skills", revision, "documents"]) {
    root = join(root, segment)
    await mkdir(root, { mode: 0o700 }).catch((error) => {
      if (!isExists(error)) throw error
    })
    if (!(await lstat(root)).isDirectory())
      throw new Error("Bundled skill directory resolves through a symlink.")
  }
  for (const [name, contents] of Object.entries(resources)) {
    const path = join(root, name)
    const temporary = join(root, `.pending-${randomUUID()}`)
    try {
      await writeFile(temporary, contents, { flag: "wx", mode: 0o600 })
      await link(temporary, path)
    } catch (error) {
      if (!isExists(error)) throw error
      const file = await lstat(path)
      if (!file.isFile() || file.isSymbolicLink() || (await readFile(path, "utf8")) !== contents) {
        throw new Error(
          `Bundled skill resource was modified: ${path}. Remove this cached bundle and load the skill again.`,
        )
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

function isExists(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
}
