export type Skill = {
  name: string
  description: string
  root: string
  instructionsPath: string
}

export type SkillCatalog = {
  skills: readonly Skill[]
  byName: ReadonlyMap<string, Skill>
}
