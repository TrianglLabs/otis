import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { DesktopRuntime } from "../desktop/main/runtime.js"
import { resolveWorkspaceCwd } from "../desktop/main/workspace.js"
import { SERVE_PORT } from "../desktop/wire.js"
import { loadLocalSettings } from "../local/settings.js"

const USAGE =
  "Usage: otis serve [--host ADDRESS] [--port PORT] [--cwd DIR]\n\n" +
  "Runs the Otis desktop runtime as a daemon that desktop apps connect to with the pairing\n" +
  "token. It listens on loopback unless --host names an interface, such as a Tailscale address.\n"

/**
 * The desktop runtime as a daemon: `otis serve` hosts it on this machine, and desktop apps
 * connect over a private network with the pairing token. Every client sees the same sessions,
 * Canvas and settings, because there is one runtime; a client that drops leaves the work running.
 */
export async function serveDesktop(options: {
  cwd: string
  host: string
  port: number
  version: string
}) {
  const runtime = await DesktopRuntime.create({
    cwd: options.cwd,
    version: options.version,
    platform: process.platform,
    send: () => {},
    sendTerminal: () => {},
    spawnPty: () => {
      throw new Error("The terminal is not available over a remote connection.")
    },
    serve: { host: options.host, port: options.port },
  })
  const { listening } = runtime.serving
  if (!listening) throw new Error("Otis could not start serving.")
  return { ...listening, close: () => runtime.shutdown() }
}

export async function runServeCommand(args: string[]) {
  const options = { host: "127.0.0.1", port: SERVE_PORT, cwd: undefined as string | undefined }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[index + 1]
    if (flag === "--help" || flag === "-h") {
      console.log(USAGE)
      return
    }
    if (!value || !["--host", "--port", "--cwd"].includes(flag ?? ""))
      throw new Error(`Unknown option: ${flag}\n\n${USAGE}`)
    index += 1
    if (flag === "--host") options.host = value
    else if (flag === "--cwd") options.cwd = value
    else {
      options.port = Number(value)
      if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
        throw new Error(`Invalid port: ${value}`)
    }
  }
  const cwd =
    options.cwd ??
    resolveWorkspaceCwd(
      process.env,
      process.cwd(),
      homedir(),
      (await loadLocalSettings()).lastWorkspace,
    )
  await mkdir(cwd, { recursive: true })
  const server = await serveDesktop({
    cwd,
    host: options.host,
    port: options.port,
    version: process.env.OTIS_VERSION ?? "dev",
  })
  console.log(`Otis is serving ${cwd}`)
  for (const { url, via } of server.urls) console.log(`  ${url}${via ? `  (${via})` : ""}`)
  console.log(`Pair a desktop app with this token: ${server.token}`)
  if (options.host === "127.0.0.1")
    console.log("Only this machine can connect; pass --host with a private address to reach it.")
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve())
  })
  await server.close()
}
