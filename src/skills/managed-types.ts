export type ManagedSkill = { name: string; relativePath: string }
export type ManagedSkillSource = { id: string; url: string; skills: ManagedSkill[] }
export type SkillManagerManifest = { version: 1; sources: ManagedSkillSource[] }
