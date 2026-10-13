import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

// Composes resources/icon.ico from the sized exports under resources/icons, so Windows draws the
// title bar, taskbar, and Explorer icons from an exact size rather than a scaled 1024px image
// (bun run build:desktop:ico). Entries stay PNG-compressed, which Windows reads since Vista.
const sizes = [16, 32, 64, 128, 256]
const root = fileURLToPath(new URL("../resources/", import.meta.url))
const images = await Promise.all(sizes.map((size) => readFile(`${root}icons/${size}x${size}.png`)))

const directory = Buffer.alloc(6 + 16 * sizes.length)
directory.writeUInt16LE(1, 2)
directory.writeUInt16LE(sizes.length, 4)
let offset = directory.length
sizes.forEach((size, index) => {
  const entry = 6 + 16 * index
  // A 256-pixel edge is written as 0, the format's spelling of 256.
  directory.writeUInt8(size % 256, entry)
  directory.writeUInt8(size % 256, entry + 1)
  directory.writeUInt16LE(1, entry + 4)
  directory.writeUInt16LE(32, entry + 6)
  directory.writeUInt32LE(images[index].length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  offset += images[index].length
})
await writeFile(`${root}icon.ico`, Buffer.concat([directory, ...images]))
console.log(`Generated resources/icon.ico with ${sizes.join(", ")} pixel entries.`)
