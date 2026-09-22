// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { UiLanguage } from "../../../src/desktop/contracts.js"
import { agentSummary } from "../../../src/desktop/renderer/features/agents/AgentTraceOverlay.js"
import { formatSessionDetail } from "../../../src/desktop/renderer/format.js"
import {
  I18nProvider,
  LANGUAGE_OPTIONS,
  useI18n,
} from "../../../src/desktop/renderer/i18n/index.js"
import { de } from "../../../src/desktop/renderer/i18n/messages/de.js"
import { en } from "../../../src/desktop/renderer/i18n/messages/en.js"
import { es } from "../../../src/desktop/renderer/i18n/messages/es.js"
import { fr } from "../../../src/desktop/renderer/i18n/messages/fr.js"
import { ja } from "../../../src/desktop/renderer/i18n/messages/ja.js"
import { ko } from "../../../src/desktop/renderer/i18n/messages/ko.js"
import { pl } from "../../../src/desktop/renderer/i18n/messages/pl.js"
import { ptBR } from "../../../src/desktop/renderer/i18n/messages/pt-BR.js"
import { uk } from "../../../src/desktop/renderer/i18n/messages/uk.js"
import { zhCN } from "../../../src/desktop/renderer/i18n/messages/zh-CN.js"

const catalogs = { en, "zh-CN": zhCN, ja, ko, es, fr, de, pl, uk, "pt-BR": ptBR }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * The provider's resolved locale and translator for a language choice under the given system
 * languages.
 */
function resolve(language: UiLanguage, systemLanguages: readonly string[]) {
  vi.spyOn(navigator, "languages", "get").mockReturnValue([...systemLanguages])
  let value: ReturnType<typeof useI18n> | undefined
  function Probe() {
    value = useI18n()
    return null
  }
  const view = render(
    <I18nProvider language={language}>
      <Probe />
    </I18nProvider>,
  )
  view.unmount()
  if (!value) throw new Error("provider did not render")
  return value
}

describe("desktop locale resolution", () => {
  it("honors an explicit language and maps supported system locale variants", () => {
    expect(resolve("fr", ["ja-JP"]).locale).toBe("fr")
    expect(resolve("system", ["zh-Hans-CN", "en-US"]).locale).toBe("zh-CN")
    expect(resolve("system", ["pt-PT", "de-DE"]).locale).toBe("de")
    expect(resolve("system", ["pt-BR"]).locale).toBe("pt-BR")
    expect(resolve("system", ["pl-PL"]).locale).toBe("pl")
    expect(resolve("system", ["uk-UA"]).locale).toBe("uk")
  })

  it("falls back to English for unsupported and Traditional Chinese system locales", () => {
    expect(resolve("system", ["it-IT"]).locale).toBe("en")
    expect(resolve("system", ["zh-Hant-TW"]).locale).toBe("en")
    expect(resolve("system", []).locale).toBe("en")
  })

  it("offers every catalog as a language option, plus following the system", () => {
    expect(LANGUAGE_OPTIONS.map((option) => option.value)).toEqual([
      "system",
      ...Object.keys(catalogs),
    ])
  })

  it("renders the selected catalog and localizes session ages", () => {
    function Label() {
      const { locale, t } = useI18n()
      return <span>{`${t("common.settings")} · ${formatSessionDetail("3h ago", locale)}`}</span>
    }

    render(
      <I18nProvider language="fr">
        <Label />
      </I18nProvider>,
    )
    expect(screen.getByText("Réglages · il y a 3 h")).toBeTruthy()
    expect(document.documentElement.lang).toBe("fr")
  })

  it("keeps the detected system language independent of an explicit choice and follows system changes", () => {
    const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["pl-PL"])
    function Label() {
      const { systemLocale, t } = useI18n()
      return <span>{`${systemLocale}: ${t("common.settings")}`}</span>
    }
    const { rerender } = render(
      <I18nProvider language="uk">
        <Label />
      </I18nProvider>,
    )
    expect(screen.getByText("pl: Налаштування")).toBeTruthy()
    rerender(
      <I18nProvider language="system">
        <Label />
      </I18nProvider>,
    )
    expect(screen.getByText("pl: Ustawienia")).toBeTruthy()
    languages.mockReturnValue(["uk-UA"])
    act(() => window.dispatchEvent(new Event("languagechange")))
    expect(screen.getByText("uk: Налаштування")).toBeTruthy()
    expect(document.documentElement.lang).toBe("uk")
  })

  it.each([
    [
      "pl",
      [
        "0 narzędzi",
        "1 narzędzie",
        "2 narzędzia",
        "5 narzędzi",
        "12 narzędzi",
        "21 narzędzi",
        "22 narzędzia",
      ],
    ],
    [
      "uk",
      [
        "0 інструментів",
        "1 інструмент",
        "2 інструменти",
        "5 інструментів",
        "12 інструментів",
        "21 інструмент",
        "22 інструменти",
      ],
    ],
  ] as const)("uses %s plural rules for coworker tool counts", (locale, expected) => {
    const { t } = resolve(locale, [])
    expect(
      [0, 1, 2, 5, 12, 21, 22].map((tools) => agentSummary({ status: "complete", tools }, t)),
    ).toEqual(expected)
  })

  it.each(
    Object.entries(catalogs),
  )("%s has every message and preserves interpolation markers in every plural form", (_locale, messages) => {
    const forms = (message: string | object): string[] =>
      typeof message === "string" ? [message] : Object.values(message)
    const markers = (value: string) =>
      [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort()
    expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const expected = markers(forms(en[key])[0])
      for (const value of forms(messages[key])) {
        expect(value.trim(), key).not.toBe("")
        expect(markers(value), key).toEqual(expected)
      }
    }
  })
})
