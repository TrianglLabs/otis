# Desktop icons

The home-screen and Dock artwork share `src/desktop/renderer/components/OtisMark.tsx`.
The O face uses the renderer's accent color; the other faces use its text color in the Dock.

`icon.png` and the multi-resolution `icon.icns` are the default app icon. `icons/` contains
the other theme variants, selected by the main process while the app is running. Finder and
the Dock when the app is closed use the default icon.

After changing the mark or theme CSS, run `bun run build:desktop:icons` on macOS and include
the regenerated assets in the change. This uses the installed Electron renderer and macOS
`iconutil`, without accessing the network. Ordinary builds only copy these assets.
