import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { FireworksModel } from "../inference/types.js"
import { localConfigDirectory } from "./paths.js"

export type LocalSettings = {
  fireworksApiKey?: string
  parallelApiKey?: string
  model?: string
  modelDisplayName?: string
  modelContextLength?: number
  theme?: ThemeName
}

export const THEME_NAMES = ["default", "nord", "bright", "matrix"] as const
export type ThemeName = (typeof THEME_NAMES)[number]

export type SettingsFileOptions = {
  file?: string
  env?: Record<string, string | undefined>
}

type SettingsFile = {
  version: 1
  fireworksApiKey?: string
  parallelApiKey?: string
  model?: string
  modelDisplayName?: string
  modelContextLength?: number
  theme?: ThemeName
}

export async function loadLocalSettings(options: SettingsFileOptions = {}): Promise<LocalSettings> {
  const env = options.env ?? process.env
  const saved = await readSettingsFile(options)
  const envFireworksApiKey = clean(env.FIREWORKS_API_KEY)
  const envParallelApiKey = clean(env.PARALLEL_API_KEY)

  return {
    fireworksApiKey: envFireworksApiKey ?? saved?.fireworksApiKey,
    parallelApiKey: envParallelApiKey ?? saved?.parallelApiKey,
    model: saved?.model,
    modelDisplayName: saved?.modelDisplayName,
    modelContextLength: saved?.modelContextLength,
    ...(saved?.theme ? { theme: saved.theme } : {}),
  }
}

export async function saveFireworksSetup(apiKey: string, model: FireworksModel, options: SettingsFileOptions = {}) {
  const saved = (await readSettingsFile(options)) ?? { version: 1 }
  await writeSettingsFile(
    withSelectedModel({ ...saved, fireworksApiKey: required(apiKey, "Fireworks API key") }, model),
    options,
  )
}

export async function saveParallelApiKey(apiKey: string, options: SettingsFileOptions = {}) {
  const saved = (await readSettingsFile(options)) ?? { version: 1 }
  await writeSettingsFile({ ...saved, parallelApiKey: required(apiKey, "Parallel API key") }, options)
}

export async function saveSelectedModel(model: FireworksModel, options: SettingsFileOptions = {}) {
  const saved = (await readSettingsFile(options)) ?? { version: 1 }
  await writeSettingsFile(withSelectedModel(saved, model), options)
}

export async function saveSelectedTheme(theme: ThemeName, options: SettingsFileOptions = {}) {
  const saved = (await readSettingsFile(options)) ?? { version: 1 }
  await writeSettingsFile({ ...saved, theme }, options)
}

function defaultSettingsFile() {
  return join(localConfigDirectory(), "config.json")
}

async function readSettingsFile(options: SettingsFileOptions): Promise<SettingsFile | undefined> {
  let content: string
  try {
    content = await readFile(settingsFilePath(options), "utf8")
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new Error(`Invalid Otis config: ${errorMessage(error)}`)
  }
  return parseSettingsFile(value)
}

async function writeSettingsFile(settings: SettingsFile, options: SettingsFileOptions) {
  const filePath = settingsFilePath(options)
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmodPrivate(directory, 0o700)
  const temporaryFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryFile, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await chmodPrivate(temporaryFile, 0o600)
    await rename(temporaryFile, filePath)
  } finally {
    await rm(temporaryFile, { force: true })
  }
}

function parseSettingsFile(value: unknown): SettingsFile {
  if (!isRecord(value)) throw new Error("Invalid Otis config: expected an object.")
  if (value.version !== 1) throw new Error("Invalid Otis config: unsupported version.")

  const fireworksApiKey = optionalString(value.fireworksApiKey, "fireworksApiKey")
  const parallelApiKey = optionalString(value.parallelApiKey, "parallelApiKey")
  const model = optionalString(value.model, "model")
  const modelDisplayName = optionalString(value.modelDisplayName, "modelDisplayName")
  const modelContextLength = optionalPositiveInteger(value.modelContextLength, "modelContextLength")
  const theme = optionalTheme(value.theme)
  return {
    version: 1,
    ...(fireworksApiKey ? { fireworksApiKey } : {}),
    ...(parallelApiKey ? { parallelApiKey } : {}),
    ...(model ? { model } : {}),
    ...(modelDisplayName ? { modelDisplayName } : {}),
    ...(modelContextLength ? { modelContextLength } : {}),
    ...(theme ? { theme } : {}),
  }
}

function withSelectedModel(settings: SettingsFile, model: FireworksModel): SettingsFile {
  const contextLength =
    model.contextLength === undefined
      ? undefined
      : positiveInteger(model.contextLength, "Fireworks model context length")
  return {
    version: 1,
    ...(settings.fireworksApiKey ? { fireworksApiKey: settings.fireworksApiKey } : {}),
    ...(settings.parallelApiKey ? { parallelApiKey: settings.parallelApiKey } : {}),
    model: required(model.id, "Fireworks model"),
    modelDisplayName: required(model.displayName, "Fireworks model display name"),
    ...(contextLength ? { modelContextLength: contextLength } : {}),
    ...(settings.theme ? { theme: settings.theme } : {}),
  }
}

function optionalTheme(value: unknown): ThemeName | undefined {
  if (value === undefined) return undefined
  if (isThemeName(value)) return value
  throw new Error("Invalid Otis config: theme must be default, nord, bright, or matrix.")
}

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value)
}

function optionalString(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Otis config: ${name} must be a string.`)
  return value.trim()
}

function required(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  return trimmed
}

function optionalPositiveInteger(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid Otis config: ${name} must be a positive integer.`)
  }
  return value
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`)
  return value
}

function settingsFilePath(options: SettingsFileOptions) {
  return options.file ? resolve(options.file) : defaultSettingsFile()
}

async function chmodPrivate(path: string, mode: number) {
  if (process.platform !== "win32") await chmod(path, mode)
}

function clean(value: string | undefined) {
  return value?.trim() || undefined
}

function isNotFound(error: unknown) {
  return isRecord(error) && error.code === "ENOENT"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
