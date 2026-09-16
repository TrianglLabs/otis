# Desktop translations

`messages/en.ts` is the canonical catalog. Every catalog must implement `Messages` without spreading English;
typechecking catches missing keys. Keep product names, model names, keyboard shortcuts,
and interpolation markers such as `{{version}}` unchanged.

Count-dependent messages can use an object with `one`, `few`, `many`, and other CLDR plural categories.
Always include `other`. The translator chooses the form with `Intl.PluralRules` using the numeric `count` value.
Catalog tests verify key and interpolation-marker parity for every form.

To add a language:

1. Add its code to `UI_LANGUAGES` in `src/local/settings.ts`.
2. Add a catalog in `messages/` that satisfies `Messages` and register it in `i18n/index.tsx`.
3. Add its native name to `LANGUAGE_OPTIONS` and its system-locale mapping to `resolveLocale`.
4. Add the locale code to the selector test in `tests/desktop/renderer/app-shell.test.tsx`.

Run `bun run check`, `bun run typecheck`, and the desktop renderer tests before submitting a translation.
