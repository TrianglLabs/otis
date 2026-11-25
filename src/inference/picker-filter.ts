/** Picker search, kept free of Node modules so the desktop renderer can import it. */

import type { ModelPickerChoice, ModelPickerItem } from "./picker-catalog.js"
import { HOSTED_PROVIDER_INFO, isServerProvider, type ModelProvider, SERVER_INFO } from "./types.js"

/**
 * A model named by its provider and catalog id: how settings record a hidden model, and how a
 * picker row is keyed, since a hosted catalog can list the very id a managed-local model uses.
 */
export function modelKey(provider: ModelProvider, id: string) {
  return `${provider}:${id}`
}

/**
 * One key per picker row, for selection, load status, and rendering: PAIR and server rows carry
 * theirs, built the same way with the engine in between; local and hosted rows are keyed here.
 */
export function pickerItemKey(item: ModelPickerChoice): string {
  return "selectionKey" in item ? item.selectionKey : modelKey(item.provider, item.id)
}

/** What a picker row's provider is called, for search and labels. */
export function providerLabel(provider: ModelProvider) {
  if (provider === "local") return "Local"
  if (provider === "pair") return "NVIDIA PAIR"
  if (isServerProvider(provider)) return SERVER_INFO[provider].name
  return HOSTED_PROVIDER_INFO[provider].name
}

/**
 * Moves the rows the user favorited, keyed by `pickerItemKey`, out of their provider sections
 * into a Favorites section on top, in catalog order; a provider section left empty is dropped.
 */
export function arrangeFavorites(
  items: readonly ModelPickerItem[],
  favorites: ReadonlySet<string>,
): readonly ModelPickerItem[] {
  const isFavorite = (item: ModelPickerItem) =>
    item.kind === "model" && favorites.has(pickerItemKey(item))
  const favored = items.filter(isFavorite)
  if (favored.length === 0) return items
  const rest = items.filter((item) => !isFavorite(item))
  return [
    { kind: "header", id: "header-favorites", displayName: "Favorites" },
    ...favored,
    ...rest.filter((item, index) => item.kind === "model" || rest[index + 1]?.kind === "model"),
  ]
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)

/**
 * The rows matching `query`, each under its section header; headers without a match are
 * dropped. Every word typed must begin a word of the row's name, the last segment of its id, its
 * provider, or its vendor, or run on across the words that follow, so "glm 5" and "glm5" find
 * GLM-5.3, "fire" the Fireworks rows, and "anthropic" the Claude rows listed under that vendor,
 * while "model" no longer finds every `accounts/fireworks/models/…` id and "ai" every `-ai`
 * organization.
 */
export function filterModelPickerItems<T extends ModelPickerItem>(
  items: readonly T[],
  query: string,
): T[] {
  const needles = words(query)
  if (needles.length === 0) return [...items]
  const result: T[] = []
  let header: T | undefined
  for (const item of items) {
    if (item.kind === "header") {
      header = item
      continue
    }
    const haystack = words(
      `${item.displayName} ${item.id.split("/").at(-1)} ${providerLabel(item.provider)} ${
        modelVendor(item)?.name ?? ""
      }`,
    )
    const begins = (needle: string) =>
      haystack.some((_, index) => haystack.slice(index).join("").startsWith(needle))
    if (!needles.every(begins)) continue
    if (header) result.push(header)
    header = undefined
    result.push(item)
  }
  return result
}

/**
 * The companies whose models Otis lists: each vendor's name, the Hugging Face or provider
 * organizations its model ids start with, and the model families its names start with, for ids
 * that carry no organization (Fireworks, local servers) and for usage kept by name. xAI is listed
 * by its current name, SpaceXSI, which OpenRouter uses too.
 */
export const VENDORS = {
  aionlabs: { name: "AionLabs", orgs: ["aion-labs"], families: /^aion\b/ },
  amazon: { name: "Amazon", orgs: ["amazon"], families: /^nova\b/ },
  anthropic: { name: "Anthropic", orgs: ["anthropic"], families: /^claude\b/ },
  baidu: { name: "Baidu", orgs: ["baidu"], families: /^ernie\b/ },
  baseten: {
    name: "Baseten",
    orgs: ["baseten", "baselabs", "decision-models"],
    families: /^(joey|elephant|mammoth|bison|groundhog)-\d/,
  },
  bytedance: { name: "ByteDance", orgs: ["bytedance", "bytedance-seed"], families: /^doubao\b/ },
  cloudflare: { name: "Cloudflare", orgs: ["cloudflare"] },
  cohere: { name: "Cohere", orgs: ["cohere", "coherelabs"], families: /^(command|aya)\b/ },
  conway: { name: "Conway Research", orgs: ["conwayresearch"], families: /^(underdog|saluki)\b/ },
  deepseek: { name: "DeepSeek", orgs: ["deepseek", "deepseek-ai"], families: /^deepseek/ },
  elorian: { name: "Elorian", orgs: ["elorian"] },
  fireworks: { name: "Fireworks AI", orgs: ["fireworks"], families: /^ember\b/ },
  google: { name: "Google", orgs: ["google"], families: /^(gemini|gemma)/ },
  ibm: { name: "IBM", orgs: ["ibm", "ibm-granite"], families: /^granite\b/ },
  inclusionai: { name: "inclusionAI", orgs: ["inclusionai"], families: /^(ling|ring)\b/ },
  inferencenet: { name: "Inference.net", orgs: ["inference-net"], families: /^schematron\b/ },
  kt: { name: "KT", orgs: ["kt"], families: /^midm\b/ },
  liquid: { name: "Liquid AI", orgs: ["liquid", "liquidai"], families: /^lfm/ },
  meta: {
    name: "Meta",
    orgs: ["meta", "meta-llama", "facebook", "meta-models"],
    families: /^(llama|muse)/,
  },
  microsoft: { name: "Microsoft", orgs: ["microsoft"], families: /^phi-?\d/ },
  minimax: { name: "MiniMax", orgs: ["minimax", "minimaxai"], families: /^minimax/ },
  mistral: {
    name: "Mistral AI",
    orgs: ["mistralai"],
    families: /^(mistral|mixtral|devstral|codestral|magistral|ministral|pixtral)/,
  },
  moondream: { name: "Moondream", orgs: ["moondream", "vikhyatk"], families: /^moondream/ },
  moonshot: { name: "Moonshot AI", orgs: ["moonshotai"], families: /^(kimi|moonshot)/ },
  morph: { name: "Morph", orgs: ["morph", "morphllm"], families: /^morph\b/ },
  motif: { name: "Motif Technologies", orgs: ["motif-technologies"], families: /^motif\b/ },
  nexagi: { name: "Nex AGI", orgs: ["nex-agi"] },
  nousresearch: { name: "Nous Research", orgs: ["nousresearch"], families: /^hermes\b/ },
  nvidia: { name: "NVIDIA", orgs: ["nvidia"], families: /^nemotron/ },
  openai: { name: "OpenAI", orgs: ["openai"], families: /^(gpt|chatgpt|o[134])\b/ },
  openrouter: { name: "OpenRouter", orgs: ["openrouter"] },
  ornith: { name: "Ornith", orgs: ["ornith-ai"], families: /^ornith\b/ },
  particle: { name: "Particle AI", orgs: ["particle-ai"] },
  perceptron: { name: "Perceptron", orgs: ["perceptron"] },
  perplexity: { name: "Perplexity", orgs: ["perplexity", "perplexity-ai"], families: /^sonar\b/ },
  poolside: { name: "Poolside", orgs: ["poolside"], families: /^(laguna|malibu)\b/ },
  prism: { name: "PrismML", orgs: ["prism-ml"], families: /^(ternary-)?bonsai\b/ },
  qwen: { name: "Qwen", orgs: ["qwen"], families: /^(qwen|qwq)/ },
  radixark: { name: "RadixArk", orgs: ["radixark"] },
  reflection: { name: "Reflection", orgs: ["reflection"], families: /^beam\b/ },
  reka: { name: "Reka", orgs: ["reka", "rekaai"], families: /^reka\b/ },
  relace: { name: "Relace", orgs: ["relace"] },
  ricursive: { name: "Ricursive", orgs: ["ricursiveai"], families: /^ripple\b/ },
  sakana: { name: "Sakana AI", orgs: ["sakana", "sakanaai"], families: /^fugu\b/ },
  stepfun: { name: "StepFun", orgs: ["stepfun", "stepfun-ai"], families: /^step-?\d/ },
  tencent: { name: "Tencent", orgs: ["tencent"], families: /^(hunyuan|hy\d)/ },
  thinkingmachines: { name: "Thinking Machines", orgs: ["thinkingmachines"], families: /^inkling/ },
  typesafe: { name: "TypeSafe", orgs: ["typesafe", "typesafe-ai"], families: /^jev\b/ },
  unbiased: { name: "Unbiased", orgs: ["unbiased"] },
  upstage: { name: "Upstage", orgs: ["upstage"], families: /^solar\b/ },
  writer: { name: "Writer", orgs: ["writer"], families: /^palmyra\b/ },
  xai: { name: "SpaceXSI", orgs: ["x-ai", "xai"], families: /^grok/ },
  xiaomi: { name: "Xiaomi", orgs: ["xiaomi", "xiaomimimo"], families: /^mimo\b/ },
  zai: { name: "Z.ai", orgs: ["z-ai", "zai-org", "thudm", "zhipuai"], families: /^(glm|chatglm)/ },
} satisfies Record<string, { name: string; orgs: readonly string[]; families?: RegExp }>

export type VendorId = keyof typeof VENDORS

export type ModelVendor = { id: VendorId; name: string }

const VENDOR_IDS = Object.keys(VENDORS) as VendorId[]

/**
 * Who makes a model: the organization its id starts with, else the family its id or name starts
 * with. Fireworks ids (`accounts/fireworks/models/kimi-k2p6`) carry no organization, and usage
 * keeps models by name.
 */
export function modelVendor(model: { id?: string; displayName: string }): ModelVendor | undefined {
  const segments = model.id?.split("/") ?? []
  const org = segments.length > 1 && segments[0] !== "accounts" ? segments[0].toLowerCase() : ""
  const byOrg = VENDOR_IDS.find((id) => VENDORS[id].orgs.includes(org))
  if (byOrg) return { id: byOrg, name: VENDORS[byOrg].name }
  const candidates = [segments.at(-1) ?? "", model.displayName].map((text) => text.toLowerCase())
  const byFamily = VENDOR_IDS.find((id) =>
    candidates.some((text) => (VENDORS[id] as { families?: RegExp }).families?.test(text)),
  )
  return byFamily && { id: byFamily, name: VENDORS[byFamily].name }
}

/**
 * Models grouped by vendor: vendors alphabetically, each vendor's models newest first by the
 * provider's release dates, so no pick of ours goes stale. Models of no known vendor come last,
 * under an unset vendor.
 */
export function groupByVendor<T extends { id: string; displayName: string; releasedAt?: number }>(
  models: readonly T[],
) {
  const groups = new Map<string, { vendor?: ModelVendor; rows: T[] }>()
  for (const item of models) {
    const vendor = modelVendor(item)
    const key = vendor?.id ?? ""
    const group = groups.get(key) ?? { vendor, rows: [] }
    group.rows.push(item)
    groups.set(key, group)
  }
  return [...groups.values()]
    .sort((left, right) =>
      !left.vendor || !right.vendor
        ? Number(!left.vendor) - Number(!right.vendor)
        : left.vendor.name.localeCompare(right.vendor.name),
    )
    .map((group) => ({
      ...group,
      rows: group.rows.sort(
        (left, right) =>
          (right.releasedAt ?? 0) - (left.releasedAt ?? 0) ||
          left.displayName.localeCompare(right.displayName),
      ),
    }))
}
