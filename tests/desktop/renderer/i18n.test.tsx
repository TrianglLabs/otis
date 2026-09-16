// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { agentSummary } from "../../../src/desktop/renderer/features/agents/agent-list.js"
import { formatSessionDetail } from "../../../src/desktop/renderer/format.js"
import { catalogs, I18nProvider, resolveLocale, useI18n } from "../../../src/desktop/renderer/i18n/index.js"
import { en } from "../../../src/desktop/renderer/i18n/messages/en.js"
import { createTranslator } from "../../../src/desktop/renderer/i18n/translate.js"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("desktop locale resolution", () => {
  it("honors an explicit language and maps supported system locale variants", () => {
    expect(resolveLocale("fr", ["ja-JP"])).toBe("fr")
    expect(resolveLocale("system", ["zh-Hans-CN", "en-US"])).toBe("zh-CN")
    expect(resolveLocale("system", ["pt-PT", "de-DE"])).toBe("de")
    expect(resolveLocale("system", ["pt-BR"])).toBe("pt-BR")
    expect(resolveLocale("system", ["pl-PL"])).toBe("pl")
    expect(resolveLocale("system", ["uk-UA"])).toBe("uk")
  })

  it("falls back to English for unsupported and Traditional Chinese system locales", () => {
    expect(resolveLocale("system", ["it-IT"])).toBe("en")
    expect(resolveLocale("system", ["zh-Hant-TW"])).toBe("en")
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
    ["pl", ["0 narzędzi", "1 narzędzie", "2 narzędzia", "5 narzędzi", "12 narzędzi", "21 narzędzi", "22 narzędzia"]],
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
    const t = createTranslator(catalogs[locale], locale)
    expect([0, 1, 2, 5, 12, 21, 22].map((tools) => agentSummary({ status: "complete", tools }, t))).toEqual(expected)
  })

  it.each(
    Object.entries(catalogs),
  )("%s has every message and preserves interpolation markers in every plural form", (_locale, messages) => {
    const forms = (message: string | object): string[] =>
      typeof message === "string" ? [message] : Object.values(message)
    const markers = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort()
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
