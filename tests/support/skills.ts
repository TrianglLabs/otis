import type { SkillCatalog } from "../../src/skills/catalog.js"

/** A catalog with no skills, for agent runs that need none. */
export function emptySkillCatalog(): SkillCatalog {
  return { skills: [], byName: new Map(), problems: [] }
}
