import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { isLocalModelId } from "../inference/local-catalog.js"
import { normalizePairEndpoints, type PairEndpoints } from "../inference/pair.js"
import { baseFireworksModelId, isFastFireworksModel } from "../inference/serving-path.js"
import type { CatalogModel, FireworksModel, ModelProvider, PairEngine } from "../inference/types.js"
import { type PermissionConfig, parsePermissionConfig } from "../permissions/policy.js"
import { localConfigDirectory } from "./paths.js"

export type LocalSettings = {
  fireworksApiKey?: string
  pairEndpoints?: PairEndpoints
  pairEngine?: PairEngine
  model?: string
  modelDisplayName?: string
  modelContextLength?: number
  modelSupportsImageInput?: boolean
  modelProvider?: ModelProvider
  theme?: ThemeName
  thinkingVisible?: boolean
  fastServingModels?: string[]
  modelFastId?: string
  permissions?: PermissionConfig
}

export const THEME_NAMES = [
  "default",
  "nord",
  "bright",
  "matrix",
  "midnight",
  "graphite",
  "beige",
  "vice",
  "eagan",
] as const
export type ThemeName = (typeof THEME_NAMES)[number]

export type SettingsFileOptions = {
  file?: string
  env?: Record<string, string | undefined>
}

type SettingsFile = {
  version: 1
  fireworksApiKey?: string
  pairEndpoints?: PairEndpoints
  pairEngine?: PairEngine
  model?: string
  modelDisplayName?: string
  modelContextLength?: number
  modelSupportsImageInput?: boolean
  modelProvider?: ModelProvider
  theme?: ThemeName
  thinkingVisible?: boolean
  /** Read only to migrate the released global preference to the selected model. */
  fastMode?: boolean
  fastServingModels?: string[]
  modelFastId?: string
  permissions?: PermissionConfig
}

export async function loadLocalSettings(options: SettingsFileOptions = {}): Promise<LocalSettings> {
  const env = options.env ?? process.env
  const saved = await readSettingsFile(options)
  const envFireworksApiKey = clean(env.FIREWORKS_API_KEY)
  const fastServingModels = saved ? migratedFastServingModels(saved) : []
  const pairEndpoints = saved?.pairEndpoints
  const modelProvider = saved?.modelProvider ?? inferModelProvider(saved?.model)

  return {
    fireworksApiKey: envFireworksApiKey ?? saved?.fireworksApiKey,
    ...(pairEndpoints && hasPairEndpoints(pairEndpoints) ? { pairEndpoints } : {}),
    ...(saved?.pairEngine ? { pairEngine: saved.pairEngine } : {}),
    model: saved?.model,
    modelDisplayName: saved?.modelDisplayName,
    modelContextLength: saved?.modelContextLength,
    ...(modelProvider ? { modelProvider } : {}),
    ...(saved?.modelSupportsImageInput !== undefined ? { modelSupportsImageInput: saved.modelSupportsImageInput } : {}),
    ...(saved?.theme ? { theme: saved.theme } : {}),
    ...(saved?.thinkingVisible !== undefined ? { thinkingVisible: saved.thinkingVisible } : {}),
    ...(fastServingModels.length > 0 ? { fastServingModels } : {}),
    ...(saved?.modelFastId ? { modelFastId: saved.modelFastId } : {}),
    ...(saved?.permissions ? { permissions: saved.permissions } : {}),
  }
}

export async function saveFireworksSetup(apiKey: string, model: FireworksModel, options: SettingsFileOptions = {}) {
  const saved = (await readSettingsFile(options)) ?? { version: 1 }
  await writeSettingsFile(
    withSelectedModel({ ...saved, fireworksApiKey: required(apiKey, "Fireworks API key") }, model),
    options,
  )
}

export async function saveFireworksApiKey(apiKey: string, options: SettingsFileOptions = {}) {
  const saved = (await readSettingsFile(options)) ?? { version: 1 }
  await writeSettingsFile({ ...saved, fireworksApiKey: required(apiKey, "Fireworks API key") }, options)
}

export async function savePairEndpoints(endpoints: PairEndpoints, options: SettingsFileOptions = {}) {
  const saved = (await readSettingsFile(options)) ?? { version: 1 }
  const pairEndpoints = persistedPairEndpoints(endpoints)
  if (!hasPairEndpoints(pairEndpoints)) throw new Error("At least one NVIDIA PAIR endpoint is required.")
  await writeSettingsFile({ ...saved, pairEndpoints }, options)
}

export async function saveSelectedModel(model: CatalogModel, options: SettingsFileOptions = {}) {
  const saved = (await readSettingsFile(options)) ?? { version: 1 }
  await writeSettingsFile(withSelectedModel(saved, model), options)
}

export async function clearSelectedModel(options: SettingsFileOptions = {}) {
  const saved = (await readSettingsFile(options)) ?? { version: 1 }
  await writeSettingsFile(withoutSelectedModel(saved), options)
}

export async function saveSelectedTheme(theme: ThemeName, options: SettingsFileOptions = {}) {
  const saved = (await readSettingsFile(options)) ?? { version: 1 }
  await writeSettingsFile({ ...saved, theme }, options)
}

export async function saveThinkingVisible(visible: boolean, options: SettingsFileOptions = {}) {
  const saved = (await readSettingsFile(options)) ?? { version: 1 }
  await writeSettingsFile({ ...saved, thinkingVisible: visible }, options)
}

export async function saveFastServingSelection(
  model: FireworksModel,
  fast: boolean,
  options: SettingsFileOptions = {},
) {
  const saved = (await readSettingsFile(options)) ?? { version: 1 }
  const selected = withSelectedModel(saved, model)
  const fastServingModels = new Set(selected.fastServingModels ?? [])
  const modelId = baseFireworksModelId(model.id)
  if (fast) fastServingModels.add(modelId)
  else fastServingModels.delete(modelId)
  await writeSettingsFile({ ...selected, fastServingModels: [...fastServingModels].sort() }, options)
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
  const pairEndpoints = parsePairEndpoints(value.pairEndpoints)
  const pairEngine = optionalPairEngine(value.pairEngine)
  const model = optionalString(value.model, "model")
  const modelDisplayName = optionalString(value.modelDisplayName, "modelDisplayName")
  const modelContextLength = optionalPositiveInteger(value.modelContextLength, "modelContextLength")
  const modelSupportsImageInput = optionalBoolean(value.modelSupportsImageInput, "modelSupportsImageInput")
  const theme = optionalTheme(value.theme)
  const thinkingVisible = optionalBoolean(value.thinkingVisible, "thinkingVisible")
  const fastMode = optionalBoolean(value.fastMode, "fastMode")
  const fastServingModels = optionalStringArray(value.fastServingModels, "fastServingModels")
  const modelFastId = optionalString(value.modelFastId, "modelFastId")
  const modelProvider = optionalModelProvider(value.modelProvider)
  const permissions =
    value.permissions === undefined
      ? undefined
      : parsePermissionConfig(value.permissions, "Invalid Otis config: permissions")
  return {
    version: 1,
    ...(fireworksApiKey ? { fireworksApiKey } : {}),
    ...(hasPairEndpoints(pairEndpoints) ? { pairEndpoints } : {}),
    ...(pairEngine ? { pairEngine } : {}),
    ...(model ? { model } : {}),
    ...(modelDisplayName ? { modelDisplayName } : {}),
    ...(modelContextLength ? { modelContextLength } : {}),
    ...(modelSupportsImageInput !== undefined ? { modelSupportsImageInput } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(theme ? { theme } : {}),
    ...(thinkingVisible !== undefined ? { thinkingVisible } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(fastServingModels !== undefined ? { fastServingModels } : {}),
    ...(modelFastId ? { modelFastId } : {}),
    ...(permissions ? { permissions } : {}),
  }
}

function withSelectedModel(settings: SettingsFile, model: CatalogModel): SettingsFile {
  const contextLength =
    model.provider === "pair" || model.contextLength === undefined
      ? undefined
      : positiveInteger(model.contextLength, "model context length")
  const fastServingModels = migratedFastServingModels(settings)
  const pairEndpoints = persistedPairEndpoints(
    model.provider === "pair"
      ? { ...settings.pairEndpoints, [model.engine === "ollama" ? "ollama" : "lmStudio"]: model.baseURL }
      : settings.pairEndpoints,
  )
  return {
    version: 1,
    ...(settings.fireworksApiKey ? { fireworksApiKey: settings.fireworksApiKey } : {}),
    ...(hasPairEndpoints(pairEndpoints) ? { pairEndpoints } : {}),
    ...(model.provider === "pair" ? { pairEngine: model.engine } : {}),
    model: required(model.id, "model"),
    modelDisplayName: required(model.displayName, "model display name"),
    modelProvider: model.provider,
    ...(contextLength ? { modelContextLength: contextLength } : {}),
    modelSupportsImageInput: model.supportsImageInput,
    ...(model.provider === "fireworks" && model.fastId ? { modelFastId: model.fastId } : {}),
    ...(settings.theme ? { theme: settings.theme } : {}),
    ...(settings.thinkingVisible !== undefined ? { thinkingVisible: settings.thinkingVisible } : {}),
    ...(shouldPersistFastServingModels(settings, fastServingModels) ? { fastServingModels } : {}),
    ...(settings.permissions ? { permissions: settings.permissions } : {}),
  }
}

function withoutSelectedModel(settings: SettingsFile): SettingsFile {
  const fastServingModels = migratedFastServingModels(settings)
  const pairEndpoints = persistedPairEndpoints(settings.pairEndpoints)
  return {
    version: 1,
    ...(settings.fireworksApiKey ? { fireworksApiKey: settings.fireworksApiKey } : {}),
    ...(hasPairEndpoints(pairEndpoints) ? { pairEndpoints } : {}),
    ...(settings.theme ? { theme: settings.theme } : {}),
    ...(settings.thinkingVisible !== undefined ? { thinkingVisible: settings.thinkingVisible } : {}),
    ...(shouldPersistFastServingModels(settings, fastServingModels) ? { fastServingModels } : {}),
    ...(settings.permissions ? { permissions: settings.permissions } : {}),
  }
}

function migratedFastServingModels(settings: SettingsFile) {
  if (settings.fastServingModels !== undefined) {
    return [...new Set(settings.fastServingModels.map(baseFireworksModelId))].sort()
  }
  if (!settings.model || (settings.modelProvider ?? inferModelProvider(settings.model)) !== "fireworks") return []
  return settings.fastMode === true || isFastFireworksModel(settings.model)
    ? [baseFireworksModelId(settings.model)]
    : []
}

function shouldPersistFastServingModels(settings: SettingsFile, models: string[]) {
  return models.length > 0 || settings.fastServingModels !== undefined || settings.fastMode !== undefined
}

function inferModelProvider(modelId: string | undefined): ModelProvider | undefined {
  if (!modelId) return undefined
  return isLocalModelId(modelId) ? "local" : "fireworks"
}

function optionalModelProvider(value: unknown): ModelProvider | undefined {
  if (value === undefined) return undefined
  if (value === "fireworks" || value === "local" || value === "pair") return value
  throw new Error("Invalid Otis config: modelProvider must be fireworks, local, or pair.")
}

function parsePairEndpoints(value: unknown) {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error("Invalid Otis config: pairEndpoints must be an object.")
  return persistedPairEndpoints({
    ollama: optionalString(value.ollama, "pairEndpoints.ollama"),
    lmStudio: optionalString(value.lmStudio, "pairEndpoints.lmStudio"),
  })
}

function persistedPairEndpoints(values: PairEndpoints | undefined): PairEndpoints {
  try {
    return normalizePairEndpoints(values ?? {})
  } catch (error) {
    throw new Error(`Invalid Otis config: ${errorMessage(error)}`)
  }
}

function optionalPairEngine(value: unknown): PairEngine | undefined {
  if (value === undefined) return undefined
  if (value === "ollama" || value === "lmstudio") return value
  throw new Error("Invalid Otis config: pairEngine must be ollama or lmstudio.")
}

function hasPairEndpoints(endpoints: PairEndpoints) {
  return Boolean(endpoints.ollama || endpoints.lmStudio)
}

function optionalTheme(value: unknown): ThemeName | undefined {
  if (value === undefined) return undefined
  if (isThemeName(value)) return value
  throw new Error(`Invalid Otis config: theme must be one of: ${THEME_NAMES.join(", ")}.`)
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value === "boolean") return value
  throw new Error(`Invalid Otis config: ${name} must be a boolean.`)
}

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value)
}

function optionalString(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Otis config: ${name} must be a string.`)
  return value.trim()
}

function optionalStringArray(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`Invalid Otis config: ${name} must be an array of strings.`)
  return [...new Set(value.map((item) => optionalString(item, name) as string))]
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
