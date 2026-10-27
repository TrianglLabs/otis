# Desktop app icon

`Otis.icon` is the bundled icon, authored in Apple's Icon Composer: the Obsidian pairing, with the pearl plate
as its light appearance and the dark plate as its dark one, drawn from the same cube geometry and colors as
`app-icons/obsidian-pearl.svg` and `app-icons/obsidian.svg`. macOS 26 draws it with Liquid Glass and picks the
appearance from its Icon & widget style setting, which follows Dark Mode by default. Packaged macOS builds compile
the file into `Assets.car` and a legacy ICNS using electron-builder and Xcode 26 or later.

After saving changes in Icon Composer, run `bun run build:desktop:icons` on a Mac with Xcode 26 or later, then
`bun run build:desktop:ico`, and commit the `.icon` package together with the generated `icon.icns`, `icon.png`,
`icons/`, and `icon.ico`. These exports use Apple's legacy rendition of the light appearance, including its mask and
padding. The ICNS is the DMG volume icon; the PNG is the window icon on Linux and in Electron development builds;
`icons/` holds the 16 to 512 pixel renditions that Linux packages install into the hicolor icon theme, which is
how launchers and docks find the app icon, and `icon.ico` composes them for Windows. Native Liquid Glass and system
appearance selection require a packaged macOS app.

## Desktop app icons

`app-icons/` holds the icons the desktop app shows, picked in Appearance settings: the Obsidian pairing, the default
(`obsidian-pearl.svg` on a light system appearance, `obsidian.svg` on a dark one); Obsidian dark (`obsidian.svg` in
both appearances); Macro (`macro.svg`); Aqua (`aqua.svg`); Night (`night.svg`); and Ember (`ember.svg`). The app
shows the chosen one in the Dock on macOS and as the window icon elsewhere while it runs; a packaged Mac app keeps
the bundled icon for the default, since that already is the pairing. Finder, Launchpad, installers, and Linux
launchers show the bundled icon above. The SVGs are the sources; after changing one, run

    bun run build:desktop:app-icons

which renders the 1024 pixel PNGs here with the app's own Electron, and the settings previews in
`src/desktop/renderer/assets/app-icons/`.

## macOS status bar icons

`tray/` holds the template images for the macOS status bar item: the idle, working, and alert cube variants at
20×22 and 40×44 (`@2x`). They are pure black with alpha, so the system tints them for both menu bar appearances.
`scripts/tray-icon-render.ts` derives them from the shared mark geometry, so regenerate after changing
`src/desktop/renderer/mark.ts`:

    bun run build:desktop:tray

The committed PNGs are verified byte-for-byte against the generator in `tests/desktop/main/tray.test.ts`.
