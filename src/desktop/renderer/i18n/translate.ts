import { en, type Messages, type Translate } from "./messages/en.js"

export function createTranslator(messages: Messages, locale: string): Translate {
  const plurals = new Intl.PluralRules(locale)
  return (key, values) => {
    const message = messages[key] ?? en[key]
    const template =
      typeof message === "string" ? message : (message[plurals.select(Number(values?.count ?? 0))] ?? message.other)
    if (!values) return template
    return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      Object.hasOwn(values, name) ? String(values[name]) : match,
    )
  }
}

export const englishT = createTranslator(en, "en")
