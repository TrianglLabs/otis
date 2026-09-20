export type Skill = {
  name: string
  description: string
  root: string
  instructionsPath: string
  /** Embedded first-party resources, materialized only when this skill is loaded. */
  bundled?: boolean
}

export type SkillCatalog = {
  skills: readonly Skill[]
  byName: ReadonlyMap<string, Skill>
}
