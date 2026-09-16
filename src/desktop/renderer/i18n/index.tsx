import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react"
import type { UiLanguage } from "../../contracts.js"
import { de } from "./messages/de.js"
import { en, type Messages, type Translate } from "./messages/en.js"
import { es } from "./messages/es.js"
import { fr } from "./messages/fr.js"
import { ja } from "./messages/ja.js"
import { ko } from "./messages/ko.js"
import { pl } from "./messages/pl.js"
import { ptBR } from "./messages/pt-BR.js"
import { uk } from "./messages/uk.js"
import { zhCN } from "./messages/zh-CN.js"
import { createTranslator } from "./translate.js"

export type ResolvedLocale = Exclude<UiLanguage, "system">

export const catalogs: Record<ResolvedLocale, Messages> = {
  en,
  "zh-CN": zhCN,
  ja,
  ko,
  es,
  fr,
  de,
  pl,
  uk,
  "pt-BR": ptBR,
}

export const LANGUAGE_OPTIONS: readonly { value: UiLanguage; label: string }[] = [
  { value: "system", label: "System" },
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "pl", label: "Polski" },
  { value: "uk", label: "Українська" },
  { value: "pt-BR", label: "Português (Brasil)" },
]

export type { Translate } from "./messages/en.js"

type I18nValue = { locale: ResolvedLocale; systemLocale: ResolvedLocale; t: Translate }
const I18nContext = createContext<I18nValue>({ locale: "en", systemLocale: "en", t: createTranslator(en, "en") })

export function I18nProvider({ language = "system", children }: { language?: UiLanguage; children: ReactNode }) {
  const [systemLocale, setSystemLocale] = useState(detectSystemLocale)
  useEffect(() => {
    const update = () => setSystemLocale(detectSystemLocale())
    window.addEventListener("languagechange", update)
    return () => window.removeEventListener("languagechange", update)
  }, [])
  const locale = language === "system" ? systemLocale : language
  const value = useMemo<I18nValue>(
    () => ({ locale, systemLocale, t: createTranslator(catalogs[locale], locale) }),
    [locale, systemLocale],
  )
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}

export function resolveLocale(language: UiLanguage, systemLanguages: readonly string[]): ResolvedLocale {
  if (language !== "system") return language
  for (const candidate of systemLanguages) {
    const normalized = candidate.toLowerCase()
    if (normalized === "zh" || normalized.startsWith("zh-cn") || normalized.startsWith("zh-hans")) return "zh-CN"
    if (normalized === "pt" || normalized.startsWith("pt-br")) return "pt-BR"
    const base = normalized.split("-")[0]
    if (
      base === "en" ||
      base === "ja" ||
      base === "ko" ||
      base === "es" ||
      base === "fr" ||
      base === "de" ||
      base === "pl" ||
      base === "uk"
    ) {
      return base
    }
  }
  return "en"
}

function detectSystemLocale(): ResolvedLocale {
  return resolveLocale("system", typeof navigator === "undefined" ? [] : navigator.languages)
}
