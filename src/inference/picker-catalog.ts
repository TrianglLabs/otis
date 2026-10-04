import { listHostedModels } from "./catalog.js"
import { LOCAL_MIN_CONTEXT_LENGTH } from "./context-policy.js"
import { isAnyLocalModelPackingDownloaded, isLocalGgufDownloaded } from "./gguf-cache.js"
import { detectHardware, type HardwareProbe, inferenceMemoryBudget } from "./hardware.js"
import { supportsLlamaCppTarget, unsupportedLlamaCppTargetMessage } from "./llama-binary.js"
import { findLocalModel, isLocalModelId, LOCAL_MODELS } from "./local-catalog.js"
import { fitLocalModel, formatMemoryLabel, memoryRequiredFor } from "./local-fit.js"
import { pairModelKey } from "./pair.js"
import { hiddenModelKey, providerLabel } from "./picker-filter.js"
import { matchesHostedModel } from "./serving-path.js"
import {
  HOSTED_PROVIDERS,
  type HostedApiKeys,
  type HostedModel,
  isServerProvider,
  type LocalCatalogModel,
  type ModelProvider,
  type PairCatalogModel,
  type PairEngine,
  SERVER_INFO,
  SERVER_PROVIDERS,
  type ServerCatalogModel,
  type ServerProvider,
} from "./types.js"

export type ModelPickerItem = ModelPickerHeader | ModelPickerChoice

export type ModelPickerHeader = {
  kind: "header"
  id: string
  displayName: string
}

export type ModelPickerStatus = {
  label: string
  kind: "progress" | "error"
}

export type LocalPickerChoice = LocalCatalogModel & {
  kind: "model"
  available: boolean
  recommended: boolean
  availabilityLabel: string
  loadedContextLength?: number
  /**
   * At least one packing for this model is cached, including one selected for different
   * hardware.
   */
  hasDownloadedPacking: boolean
  downloaded: boolean
  /** Some layers run on the CPU because the model exceeds the GPU budget at 64K. */
  cpuOffload: boolean
  /** Size of the selected packing's GGUF files, cached or not. */
  status?: ModelPickerStatus
  active: boolean
}

export type HostedPickerChoice = HostedModel & {
  kind: "model"
  available: true
  active: boolean
  status?: ModelPickerStatus
}

export type PairPickerChoice = PairCatalogModel & {
  kind: "model"
  available: true
  active: boolean
  selectionKey: string
  status?: ModelPickerStatus
}

export type ServerPickerChoice = ServerCatalogModel & {
  kind: "model"
  available: boolean
  availabilityLabel?: string
  active: boolean
  selectionKey: string
  status?: ModelPickerStatus
}

export type ModelPickerChoice =
  | LocalPickerChoice
  | HostedPickerChoice
  | PairPickerChoice
  | ServerPickerChoice

type ListModelPickerOptions = {
  hostedApiKeys?: HostedApiKeys
  /** Hosted models the user hid from the picker (`hiddenModelKey`); the active one still shows. */
  hiddenModels?: ReadonlySet<string>
  currentModel?: string
  currentProvider?: ModelProvider
  currentPairEngine?: PairEngine
  pairModels?: readonly PairCatalogModel[]
  serverModels?: Partial<Record<ServerProvider, readonly ServerCatalogModel[]>>
  hardware?: HardwareProbe
  dataDirectory?: string
  loadStatus?: { modelId: string; status: ModelPickerStatus }
  loadedLocalModel?: { model: string; contextLength: number }
  detect?: typeof detectHardware
  listHosted?: typeof listHostedModels
  /**
   * Keep downloaded local models listed even when they cannot run on this machine — selection
   * stays unavailable. The desktop catalog opts in so cached files remain deletable from the
   * GUI; the default (CLI) behavior keeps them hidden.
   */
  includeDownloadedUnavailable?: boolean
  signal?: AbortSignal
}

type PreferenceGroups = readonly (readonly string[])[]

// Curated preference orders, not rankings inferred from parameter count or file size.
// Peers in a group are offered together; an unavailable group falls back to the next.
const GPU_RECOMMENDATION_GROUPS: PreferenceGroups = [
  ["zai-org/GLM-5.3"],
  ["Qwen/Qwen3.8-Flash-Next"],
  ["Qwen/Qwen3.8-27B"],
  ["prism-ml/Ternary-Bonsai-2-27B-gguf"],
  ["ornith-ai/Ornith-1.5-9B", "google/gemma-4-12B-it"],
  ["LiquidAI/LFM2.5-2.6B"],
]
// Host memory bandwidth bounds generation without a GPU that holds the model: prefer mixtures of
// experts with few active parameters and small dense models over 27B-class dense weights.
const CPU_RECOMMENDATION_GROUPS: PreferenceGroups = [
  ["Qwen/Qwen3.8-Flash-Next"],
  ["openai/gpt-oss-20b", "google/gemma-4-26B-A4B-it"],
  ["ornith-ai/Ornith-1.5-9B", "google/gemma-4-12B-it"],
  ["LiquidAI/LFM2.5-2.6B"],
]

function recommendLocalModels(hardware: HardwareProbe) {
  const gpu = inferenceMemoryBudget(hardware).gpuMemoryBudgetBytes
  // A GPU that holds a whole model wins. Otherwise the host-bandwidth order applies, whether the
  // GPU is small, unreported, or absent, and the starred model may spill layers to the CPU. Intel
  // integrated graphics generate at host-memory speed too, unlike an AMD APU's wider fabric.
  const intelIntegrated = hardware.unifiedMemory && hardware.gpuVendor === "intel"
  const plans: readonly [PreferenceGroups, boolean][] =
    gpu !== undefined && gpu > 0 && !intelIntegrated
      ? [
          [GPU_RECOMMENDATION_GROUPS, false],
          [CPU_RECOMMENDATION_GROUPS, true],
        ]
      : [[CPU_RECOMMENDATION_GROUPS, true]]
  if (supportsLlamaCppTarget(hardware)) {
    for (const [groups, allowOffload] of plans) {
      for (const group of groups) {
        const fitting = group.filter((id) => {
          const model = findLocalModel(id)
          if (!model) return false
          const fit = fitLocalModel(model, hardware)
          return fit.available && (allowOffload || !fit.requiresCpuOffload)
        })
        if (fitting.length > 0) return { starred: fitting, groups }
      }
    }
  }
  return { starred: [] as readonly string[], groups: plans[0][0] }
}

export async function listModelPickerItems(
  options: ListModelPickerOptions = {},
): Promise<ModelPickerItem[]> {
  const hardware = options.hardware ?? (await (options.detect ?? detectHardware)())
  const currentProvider =
    options.currentProvider ??
    (options.currentModel
      ? isLocalModelId(options.currentModel)
        ? "local"
        : "fireworks"
      : undefined)
  const currentLocalModel = currentProvider === "local" ? options.currentModel : undefined
  const unsupported = supportsLlamaCppTarget(hardware)
    ? undefined
    : unsupportedLlamaCppTargetMessage(hardware)
  const { starred, groups } = recommendLocalModels(hardware)
  const recommendedModelIds = new Set(starred)
  // Starred rows first, then the preference order, so the first selectable row is the fallback
  // when nothing is starred; models outside the order keep their catalog position after them.
  const preference = (id: string) => {
    if (recommendedModelIds.has(id)) return -1
    const index = groups.findIndex((group) => group.includes(id))
    return index < 0 ? groups.length : index
  }
  const status = (key: string) =>
    options.loadStatus?.modelId === key ? { status: options.loadStatus.status } : {}
  const localItems = (
    await Promise.all(
      LOCAL_MODELS.map(async (model): Promise<LocalPickerChoice | undefined> => {
        const fit = fitLocalModel(model, hardware)
        const selected = fit.model
        const downloaded = await isLocalGgufDownloaded(selected, options.dataDirectory)
        const hasDownloadedPacking =
          downloaded || (await isAnyLocalModelPackingDownloaded(model, options.dataDirectory))
        if (
          !fit.available &&
          !(options.includeDownloadedUnavailable === true && hasDownloadedPacking)
        )
          return undefined
        const loaded =
          currentLocalModel === model.id && options.loadedLocalModel?.model === model.id
            ? options.loadedLocalModel.contextLength
            : undefined
        let availabilityLabel: string
        if (unsupported) availabilityLabel = unsupported
        else if (loaded !== undefined) {
          const cost = formatMemoryLabel(memoryRequiredFor(selected, loaded))
          availabilityLabel = `${formatContextWindow(loaded)} · ${selected.quant} · ${cost}`
        } else if (!fit.available)
          availabilityLabel = `Needs ${formatMemoryLabel(fit.memoryRequiredBytes)}`
        else {
          const cost = formatMemoryLabel(fit.memoryRequiredBytes)
          availabilityLabel = `Est. ${formatContextWindow(fit.contextLength)} · ${selected.quant} · ${cost}`
        }
        return {
          kind: "model",
          provider: "local",
          id: selected.id,
          displayName: selected.displayName,
          contextLength:
            loaded ?? (fit.available ? fit.contextLength : selected.nativeContextLength),
          supportsImageInput: selected.supportsImageInput,
          available: !unsupported && fit.available,
          recommended: !unsupported && fit.available && recommendedModelIds.has(selected.id),
          availabilityLabel,
          ...(loaded === undefined ? {} : { loadedContextLength: loaded }),
          downloaded,
          hasDownloadedPacking,
          cpuOffload: fit.available && fit.requiresCpuOffload,
          status:
            options.loadStatus?.modelId === selected.id ? options.loadStatus.status : undefined,
          active: currentLocalModel === selected.id,
        }
      }),
    )
  )
    .filter((item) => item !== undefined)
    .sort((a, b) => preference(a.id) - preference(b.id))

  const header = (provider: ModelProvider): ModelPickerHeader => ({
    kind: "header",
    id: `header-${provider}`,
    displayName: providerLabel(provider),
  })
  // One section per configured provider; a catalog that fails to load is simply absent this time.
  const list = options.listHosted ?? listHostedModels
  const hosted = await Promise.all(
    HOSTED_PROVIDERS.map(async (provider): Promise<ModelPickerItem[]> => {
      const apiKey = options.hostedApiKeys?.[provider]
      const models = apiKey
        ? await list(provider, apiKey, { signal: options.signal }).catch(() => [])
        : []
      const current = currentProvider === provider ? options.currentModel : undefined
      const rows = models
        .map(
          (model): HostedPickerChoice => ({
            kind: "model",
            ...model,
            available: true,
            active: current !== undefined && matchesHostedModel(model, current),
          }),
        )
        .filter((row) => row.active || !options.hiddenModels?.has(hiddenModelKey(provider, row.id)))
      return rows.length ? [header(provider), ...rows] : []
    }),
  )
  const pairModels = options.pairModels ?? []
  return [
    ...(localItems.length ? [header("local"), ...localItems] : []),
    ...(pairModels.length ? [header("pair")] : []),
    ...pairModels.map((model): PairPickerChoice => {
      // Load status is keyed like the renderer's rows: PAIR entries by selectionKey, not the
      // bare model id.
      const selectionKey = pairModelKey(model)
      return {
        ...model,
        kind: "model",
        available: true,
        active:
          options.currentProvider === "pair" &&
          options.currentModel === model.id &&
          options.currentPairEngine === model.engine,
        selectionKey,
        ...status(selectionKey),
      }
    }),
    ...SERVER_PROVIDERS.flatMap((provider) => {
      const models = options.serverModels?.[provider] ?? []
      if (!models.length) return []
      return [
        header(provider),
        ...models.map((model): ServerPickerChoice => {
          const selectionKey = `${provider}:${model.id}`
          const available =
            model.contextLength === undefined || model.contextLength >= LOCAL_MIN_CONTEXT_LENGTH
          return {
            ...model,
            kind: "model",
            available,
            ...(available
              ? {}
              : {
                  availabilityLabel:
                    `Requires 64K context. Increase the model's context in ` +
                    `${SERVER_INFO[provider].name}.`,
                }),
            selectionKey,
            active: options.currentProvider === provider && options.currentModel === model.id,
            ...status(selectionKey),
          }
        }),
      ]
    }),
    ...hosted.flat(),
  ]
}

export function isSelectablePickerItem(
  item: ModelPickerItem | undefined,
): item is ModelPickerChoice & { available: true } {
  return item?.kind === "model" && item.available === true
}

export function toLocalCatalogModel(item: LocalPickerChoice): LocalCatalogModel {
  return {
    provider: "local",
    id: item.id,
    displayName: item.displayName,
    contextLength: item.contextLength,
    supportsImageInput: item.supportsImageInput,
  }
}

export function toPairCatalogModel(item: PairPickerChoice): PairCatalogModel {
  const {
    kind: _kind,
    available: _available,
    active: _active,
    selectionKey: _key,
    status: _status,
    ...model
  } = item
  return model
}

export function isServerPickerChoice(item: ModelPickerChoice): item is ServerPickerChoice {
  return isServerProvider(item.provider)
}

export function toServerCatalogModel(item: ServerPickerChoice): ServerCatalogModel {
  return {
    provider: item.provider,
    id: item.id,
    displayName: item.displayName,
    baseURL: item.baseURL,
    contextLength: item.contextLength,
    supportsImageInput: item.supportsImageInput,
  }
}

/**
 * Exact thousands for provider-stated decimal windows, binary K for local and native windows,
 * and a rounded binary K marked `~` otherwise. Mirrored in src/desktop/renderer/format.ts.
 */
export function formatContextWindow(tokens: number) {
  if (tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens < 1_000) return String(tokens)
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K`
  if (tokens % 1_024 === 0) return `${tokens / 1_024}K`
  return `~${Math.round(tokens / 1_024)}K`
}
