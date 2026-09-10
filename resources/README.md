# Desktop app icon

`Otis.icon` is the source artwork, authored in Apple's Icon Composer. Both its default and dark appearances use
the dark design; the mono variant remains available. macOS selects appearances through its Icon & widget style
setting, which is separate from system Dark Mode. Otis themes do not change the application icon. Packaged macOS
builds compile the file into `Assets.car` and a legacy ICNS using electron-builder and Xcode 26 or later.

After saving changes in Icon Composer, run `bun run build:desktop:icons` on a Mac with Xcode 26 or later and commit
the `.icon` package together with the generated `icon.icns` and `icon.png`. These exports use Apple's legacy
rendition, including its mask and padding. The ICNS is the DMG volume icon; the PNG is used on Linux and in Electron
development builds. Native Liquid Glass and system appearance selection require a packaged macOS app.
