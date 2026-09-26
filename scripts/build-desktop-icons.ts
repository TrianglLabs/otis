import { execFileSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Author the icon in Icon Composer. Check in its static exports so Linux builds need no Apple
// tools.
if (process.platform !== "darwin")
  throw new Error("Generate desktop icons on macOS with Xcode 26 or later.")

const resources = fileURLToPath(new URL("../resources/", import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), "otis-desktop-icons-"))
try {
  // A resource bundle lets AppKit render the catalog's full-resolution legacy icon using public
  // APIs.
  const bundle = join(temporary, "Otis.bundle")
  const catalog = join(bundle, "Contents", "Resources")
  await mkdir(catalog, { recursive: true })
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.triangllabs.otis.icon-export</string>
<key>CFBundlePackageType</key><string>BNDL</string>
</dict></plist>`,
  )
  execFileSync(
    "xcrun",
    [
      "actool",
      join(resources, "Otis.icon"),
      "--compile",
      catalog,
      "--output-format",
      "human-readable-text",
      "--output-partial-info-plist",
      join(temporary, "info.plist"),
      "--app-icon",
      "Otis",
      "--include-all-app-icons",
      "--target-device",
      "mac",
      // Request the legacy bitmap renditions as well as the modern icon stack.
      "--minimum-deployment-target",
      "13.0",
      "--platform",
      "macosx",
    ],
    { stdio: "inherit" },
  )
  const iconset = join(temporary, "Otis.iconset")
  await mkdir(iconset)
  execFileSync(
    "xcrun",
    [
      "swift",
      fileURLToPath(new URL("./export-desktop-icon.swift", import.meta.url)),
      bundle,
      iconset,
    ],
    { stdio: "inherit" },
  )
  const icns = join(temporary, "Otis.icns")
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns], { stdio: "inherit" })
  await copyFile(icns, join(resources, "icon.icns"))
  await copyFile(join(iconset, "icon_512x512@2x.png"), join(resources, "icon.png"))
  // The Linux icon set: electron-builder installs each NxN.png into the hicolor theme.
  for (const [size, rendition] of [
    [16, "icon_16x16.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_256x256.png"],
    [512, "icon_512x512.png"],
  ] as const) {
    await copyFile(join(iconset, rendition), join(resources, "icons", `${size}x${size}.png`))
  }
  console.log("Generated desktop fallback icons from resources/Otis.icon.")
} finally {
  await rm(temporary, { recursive: true, force: true })
}
