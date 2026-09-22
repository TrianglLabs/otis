import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { isLocalModelId } from "../inference/local-catalog.js"
import {
  type LocalThinkingPreferences,
  validateLocalThinkingSelection,
} from "../inference/local-thinking.js"
import { normalizeOmlxSettings, type OmlxSettings } from "../inference/omlx.js"
import { normalizePairEndpoints, type PairEndpoints } from "../inference/pair.js"
import { baseFireworksModelId, isFastFireworksModel } from "../inference/serving-path.js"
import type { CatalogModel, FireworksModel, ModelProvider, PairEngine } from "../inference/types.js"
import {
  type PermissionConfig,
  type PermissionMode,
  parsePermissionConfig,
} from "../permissions/policy.js"
import { localConfigDirectory } from "./paths.js"

export type LocalSettings = {
  omlx?: OmlxSettings
  fireworksApiKey?: string
  pairEndpoints?: PairEndpoints
  pairEngine?: PairEngine
  model?: string
  modelDisplayName?: string
  modelContextLength?: number
  modelSupportsImageInput?: boolean
  modelProvider?: ModelProvider
  theme?: ThemeName
  language?: UiLanguage
  lastWorkspace?: string
  thinkingVisible?: boolean
  localThinking?: LocalThinkingPreferences
  /**
   * When false, the chat side panel that lists delegated runs stays hidden. Omitted means shown.
   */
  subagentPanelVisible?: boolean
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
  "pearl",
  "sage",
  "titanium",
] as const
export type ThemeName = (typeof THEME_NAMES)[number]

export const UI_LANGUAGES = [
  "system",
  "en",
  "zh-CN",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "pl",
  "uk",
  "pt-BR",
] as const
export type UiLanguage = (typeof UI_LANGUAGES)[number]

type SettingsFileOptions = {
  file?: string
  env?: Record<string, string | undefined>
}

type SettingsFile = LocalSettings & {
  version: 1
  /** Read only to migrate the released global preference to the selected model. */
  fastMode?: boolean
}

export async function loadLocalSettings(options: SettingsFileOptions = {}): Promise<LocalSettings> {
  const env = options.env ?? process.env
  const saved = (await readSettingsFile(options)) ?? { version: 1 }
  const { version: _version, fastMode: _fastMode, ...settings } = saved
  const fastServingModels = migratedFastServingModels(saved)
  return {
    ...defined({
      ...settings,
      modelProvider: saved.modelProvider ?? inferModelProvider(saved.model),
      fastServingModels: fastServingModels.length > 0 ? fastServingModels : undefined,
    }),
    fireworksApiKey: env.FIREWORKS_API_KEY?.trim() || saved.fireworksApiKey,
    model: saved.model,
    modelDisplayName: saved.modelDisplayName,
    modelContextLength: saved.modelContextLength,
  }
}

/**
 * Every save helper reads the settings file and rewrites it whole. Chain those read-modify-write
 * pairs so overlapping updates — a model switch landing while a panel preference saves, for
 * example — cannot clobber one another with a stale read.
 */
let settingsWriteChain: Promise<unknown> = Promise.resolve()

function serializeSettingsWrite<T>(
  options: SettingsFileOptions,
  save: (pinned: SettingsFileOptions) => Promise<T>,
): Promise<T> {
  // Resolve the target file before queueing: read-modify-write must not span an env change.
  const pinned: SettingsFileOptions = { ...options, file: settingsFilePath(options) }
  const run = settingsWriteChain.then(() => save(pinned))
  settingsWriteChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function updateSettings(
  options: SettingsFileOptions,
  update: (saved: SettingsFile) => SettingsFile,
) {
  return serializeSettingsWrite(options, async (pinned) => {
    const next = update((await readSettingsFile(pinned)) ?? { version: 1 })
    await writeSettingsFile(next, pinned)
    return next
  })
}

/** Seed a new profile once, using the normal validation and private atomic writer. */
export async function initializeLocalSettings(
  sourceFile: string,
  options: SettingsFileOptions = {},
) {
  await serializeSettingsWrite(options, async (pinned) => {
    if (await readSettingsFile(pinned)) return
    const source = await readSettingsFile({ file: sourceFile })
    if (source) await writeSettingsFile(source, pinned)
  })
}

export async function saveFireworksSetup(
  apiKey: string,
  model: FireworksModel,
  options: SettingsFileOptions = {},
) {
  await updateSettings(options, (saved) =>
    selectedModelSettings(
      { ...saved, fireworksApiKey: required(apiKey, "Fireworks API key") },
      model,
    ),
  )
}

export async function saveFireworksApiKey(apiKey: string, options: SettingsFileOptions = {}) {
  await updateSettings(options, (saved) => ({
    ...saved,
    fireworksApiKey: required(apiKey, "Fireworks API key"),
  }))
}

export async function saveSelectedModel(model: CatalogModel, options: SettingsFileOptions = {}) {
  await updateSettings(options, (saved) => selectedModelSettings(saved, model))
}

export async function saveLocalServers(
  servers: { pairEndpoints: PairEndpoints; omlx?: OmlxSettings },
  options: SettingsFileOptions = {},
) {
  const pairEndpoints = persistedPairEndpoints(servers.pairEndpoints)
  const omlx = servers.omlx && normalizeOmlxSettings(servers.omlx)
  await updateSettings(options, ({ omlx: _omlx, pairEndpoints: _pairEndpoints, ...rest }) =>
    defined({
      ...rest,
      pairEndpoints: hasPairEndpoints(pairEndpoints) ? pairEndpoints : undefined,
      omlx,
    }),
  )
}

export async function clearSelectedModel(options: SettingsFileOptions = {}) {
  await updateSettings(options, (saved) => selectedModelSettings(saved))
}

export async function saveSelectedTheme(theme: ThemeName, options: SettingsFileOptions = {}) {
  await updateSettings(options, (saved) => ({ ...saved, theme }))
}

export async function saveUiLanguage(language: UiLanguage, options: SettingsFileOptions = {}) {
  await updateSettings(options, (saved) => ({ ...saved, language }))
}

export async function saveLastWorkspace(lastWorkspace: string, options: SettingsFileOptions = {}) {
  await updateSettings(options, (saved) => ({ ...saved, lastWorkspace }))
}

export async function saveThinkingVisible(
  thinkingVisible: boolean,
  options: SettingsFileOptions = {},
) {
  await updateSettings(options, (saved) => ({ ...saved, thinkingVisible }))
}

export async function saveLocalThinking(
  model: string,
  level: string,
  options: SettingsFileOptions = {},
) {
  validateLocalThinkingSelection(model, level)
  const next = await updateSettings(options, (saved) => {
    const localThinking = { ...saved.localThinking }
    if (level === "default") delete localThinking[model]
    else localThinking[model] = level
    return { ...saved, localThinking }
  })
  return next.localThinking ?? {}
}

export async function savePermissionMode(mode: PermissionMode, options: SettingsFileOptions = {}) {
  await updateSettings(options, (saved) => ({
    ...saved,
    permissions: { ...(saved.permissions ?? { rules: [] }), defaultMode: mode },
  }))
}

export async function saveSubagentPanelVisible(
  subagentPanelVisible: boolean,
  options: SettingsFileOptions = {},
) {
  await updateSettings(options, (saved) => ({ ...saved, subagentPanelVisible }))
}

export async function saveFastServingSelection(
  model: FireworksModel,
  fast: boolean,
  options: SettingsFileOptions = {},
) {
  await updateSettings(options, (saved) => {
    const selected = selectedModelSettings(saved, model)
    const fastServingModels = new Set(selected.fastServingModels)
    const modelId = baseFireworksModelId(model.id)
    if (fast) fastServingModels.add(modelId)
    else fastServingModels.delete(modelId)
    return { ...selected, fastServingModels: [...fastServingModels].sort() }
  })
}

async function readSettingsFile(options: SettingsFileOptions): Promise<SettingsFile | undefined> {
  let content: string
  try {
    content = await readFile(settingsFilePath(options), "utf8")
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new Error(`Invalid Otis config: ${errorMessage(error)}`)
  }
  if (!isRecord(value)) throw new Error("Invalid Otis config: expected an object.")
  if (value.version !== 1) throw new Error("Invalid Otis config: unsupported version.")

  const fireworksApiKey = optionalString(value.fireworksApiKey, "fireworksApiKey")
  if (value.pairEndpoints !== undefined && !isRecord(value.pairEndpoints)) {
    throw new Error("Invalid Otis config: pairEndpoints must be an object.")
  }
  const pairEndpoints = persistedPairEndpoints({
    ollama: optionalString(value.pairEndpoints?.ollama, "pairEndpoints.ollama"),
    lmStudio: optionalString(value.pairEndpoints?.lmStudio, "pairEndpoints.lmStudio"),
  })
  let omlx: OmlxSettings | undefined
  if (value.omlx !== undefined) {
    if (!isRecord(value.omlx) || typeof value.omlx.baseURL !== "string") {
      throw new Error("Invalid Otis config: omlx must contain a baseURL.")
    }
    omlx = normalizeOmlxSettings({
      baseURL: value.omlx.baseURL,
      apiKey: optionalString(value.omlx.apiKey, "omlx.apiKey"),
    })
  }
  const pairEngine = optionalChoice(
    value.pairEngine,
    ["ollama", "lmstudio"],
    "Invalid Otis config: pairEngine must be ollama or lmstudio.",
  )
  const model = optionalString(value.model, "model")
  const modelDisplayName = optionalString(value.modelDisplayName, "modelDisplayName")
  const modelContextLength = value.modelContextLength
  if (
    modelContextLength !== undefined &&
    (typeof modelContextLength !== "number" ||
      !Number.isSafeInteger(modelContextLength) ||
      modelContextLength <= 0)
  ) {
    throw new Error("Invalid Otis config: modelContextLength must be a positive integer.")
  }
  const modelSupportsImageInput = optionalBoolean(
    value.modelSupportsImageInput,
    "modelSupportsImageInput",
  )
  const language = optionalChoice(
    value.language,
    UI_LANGUAGES,
    `Invalid Otis config: language must be one of ${UI_LANGUAGES.join(", ")}.`,
  )
  const lastWorkspace = optionalString(value.lastWorkspace, "lastWorkspace")
  let localThinking: LocalThinkingPreferences | undefined
  if (value.localThinking !== undefined) {
    if (!isRecord(value.localThinking))
      throw new Error("Invalid Otis config: localThinking must be an object.")
    localThinking = {}
    for (const [thinkingModel, level] of Object.entries(value.localThinking)) {
      if (typeof level !== "string")
        throw new Error("Invalid Otis config: invalid local thinking effort.")
      validateLocalThinkingSelection(thinkingModel, level)
      if (level !== "default") localThinking[thinkingModel] = level
    }
  }
  const thinkingVisible = optionalBoolean(value.thinkingVisible, "thinkingVisible")
  const subagentPanelVisible = optionalBoolean(value.subagentPanelVisible, "subagentPanelVisible")
  const fastMode = optionalBoolean(value.fastMode, "fastMode")
  if (value.fastServingModels !== undefined && !Array.isArray(value.fastServingModels)) {
    throw new Error("Invalid Otis config: fastServingModels must be an array of strings.")
  }
  const fastServingModels = value.fastServingModels && [
    ...new Set(
      value.fastServingModels.map((item) => optionalString(item, "fastServingModels") as string),
    ),
  ]
  const modelFastId = optionalString(value.modelFastId, "modelFastId")
  const modelProvider = optionalChoice(
    value.modelProvider,
    ["fireworks", "local", "pair", "omlx"],
    "Invalid Otis config: modelProvider must be fireworks, local, pair, or omlx.",
  )
  const permissions =
    value.permissions === undefined
      ? undefined
      : parsePermissionConfig(value.permissions, "Invalid Otis config: permissions")
  return defined({
    version: 1 as const,
    fireworksApiKey,
    pairEndpoints: hasPairEndpoints(pairEndpoints) ? pairEndpoints : undefined,
    omlx,
    pairEngine,
    model,
    modelDisplayName,
    modelContextLength,
    modelSupportsImageInput,
    modelProvider,
    // The theme list changes across releases; an unrecognized saved name (e.g. a removed theme)
    // falls back to the default rather than blocking startup over a cosmetic preference.
    theme: isThemeName(value.theme) ? value.theme : undefined,
    language,
    lastWorkspace,
    localThinking,
    thinkingVisible,
    subagentPanelVisible,
    fastMode,
    fastServingModels,
    modelFastId,
    permissions,
  })
}

async function writeSettingsFile(settings: SettingsFile, options: SettingsFileOptions) {
  const filePath = settingsFilePath(options)
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmodPrivate(directory, 0o700)
  const temporaryFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryFile, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    await chmodPrivate(temporaryFile, 0o600)
    await rename(temporaryFile, filePath)
  } finally {
    await rm(temporaryFile, { force: true })
  }
}

/** The settings with the model fields replaced by `model`, or cleared when no model is given. */
function selectedModelSettings(settings: SettingsFile, model?: CatalogModel): SettingsFile {
  const contextLength = model && model.provider !== "pair" ? model.contextLength : undefined
  if (contextLength !== undefined && (!Number.isSafeInteger(contextLength) || contextLength <= 0)) {
    throw new Error("model context length must be a positive integer.")
  }
  const fastServingModels = migratedFastServingModels(settings)
  const pairEndpoints = persistedPairEndpoints(
    model?.provider === "pair"
      ? {
          ...settings.pairEndpoints,
          [model.engine === "ollama" ? "ollama" : "lmStudio"]: model.baseURL,
        }
      : settings.pairEndpoints,
  )
  return defined({
    version: 1 as const,
    omlx: settings.omlx,
    fireworksApiKey: settings.fireworksApiKey,
    pairEndpoints: hasPairEndpoints(pairEndpoints) ? pairEndpoints : undefined,
    ...(model
      ? {
          pairEngine: model.provider === "pair" ? model.engine : undefined,
          model: required(model.id, "model"),
          modelDisplayName: required(model.displayName, "model display name"),
          modelProvider: model.provider,
          modelContextLength: contextLength,
          modelSupportsImageInput: model.supportsImageInput,
          modelFastId: model.provider === "fireworks" && model.fastId ? model.fastId : undefined,
        }
      : {}),
    theme: settings.theme,
    language: settings.language,
    lastWorkspace: settings.lastWorkspace,
    localThinking: settings.localThinking,
    thinkingVisible: settings.thinkingVisible,
    subagentPanelVisible: settings.subagentPanelVisible,
    fastServingModels:
      fastServingModels.length > 0 ||
      settings.fastServingModels !== undefined ||
      settings.fastMode !== undefined
        ? fastServingModels
        : undefined,
    permissions: settings.permissions,
  })
}

function migratedFastServingModels(settings: SettingsFile) {
  if (settings.fastServingModels !== undefined) {
    return [...new Set(settings.fastServingModels.map(baseFireworksModelId))].sort()
  }
  if (
    !settings.model ||
    (settings.modelProvider ?? inferModelProvider(settings.model)) !== "fireworks"
  )
    return []
  return settings.fastMode === true || isFastFireworksModel(settings.model)
    ? [baseFireworksModelId(settings.model)]
    : []
}

function inferModelProvider(modelId: string | undefined): ModelProvider | undefined {
  if (!modelId) return undefined
  return isLocalModelId(modelId) ? "local" : "fireworks"
}

function persistedPairEndpoints(values: PairEndpoints | undefined): PairEndpoints {
  try {
    return normalizePairEndpoints(values ?? {})
  } catch (error) {
    throw new Error(`Invalid Otis config: ${errorMessage(error)}`)
  }
}

function hasPairEndpoints(endpoints: PairEndpoints) {
  return Boolean(endpoints.ollama || endpoints.lmStudio)
}

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value)
}

function optionalChoice<T extends string>(
  value: unknown,
  choices: readonly T[],
  message: string,
): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string" && choices.includes(value as T)) return value as T
  throw new Error(message)
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value === "boolean") return value
  throw new Error(`Invalid Otis config: ${name} must be a boolean.`)
}

function optionalString(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid Otis config: ${name} must be a string.`)
  return value.trim()
}

function required(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  return trimmed
}

/**
 * Drops undefined entries so optional settings are omitted rather than written as explicit
 * absences.
 */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

function settingsFilePath(options: SettingsFileOptions) {
  return options.file ? resolve(options.file) : join(localConfigDirectory(), "config.json")
}

async function chmodPrivate(path: string, mode: number) {
  if (process.platform !== "win32") await chmod(path, mode)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
