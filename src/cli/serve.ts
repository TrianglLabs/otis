import { randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir, networkInterfaces } from "node:os"
import { join } from "node:path"
import { resolveWorkspaceCwd } from "../desktop/main/workspace.js"
import { serveDesktop } from "../desktop/serve.js"
import { SERVE_PORT } from "../desktop/wire.js"
import { localConfigDirectory } from "../local/paths.js"
import { loadLocalSettings } from "../local/settings.js"

const USAGE =
  "Usage: otis serve [--host ADDRESS] [--port PORT] [--cwd DIR]\n\n" +
  "Runs the Otis desktop runtime as a daemon that desktop apps connect to with the pairing\n" +
  "token. It listens on loopback unless --host names an interface, such as a Tailscale address.\n"

/** The pairing token, created privately on first use and reused by every later `serve`. */
export async function serveToken() {
  const path = join(localConfigDirectory(), "serve-token")
  const saved = (await readFile(path, "utf8").catch(() => "")).trim()
  if (saved) return saved
  const token = randomBytes(32).toString("hex")
  await mkdir(localConfigDirectory(), { recursive: true, mode: 0o700 })
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  return token
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
  const token = await serveToken()
  const server = await serveDesktop({
    cwd,
    host: options.host,
    port: options.port,
    version: process.env.OTIS_VERSION ?? "dev",
    token,
  })
  // A wildcard bind is reachable at each interface's address; those are what a client pastes.
  const addresses = ["0.0.0.0", "::"].includes(options.host)
    ? Object.values(networkInterfaces())
        .flat()
        .filter((net) => net && net.family === "IPv4" && !net.internal)
        .map((net) => `ws://${net?.address}:${server.port}`)
    : [server.url]
  console.log(`Otis is serving ${cwd}`)
  for (const address of addresses) console.log(`  ${address}`)
  console.log(`Pair a desktop app with this token: ${token}`)
  if (options.host === "127.0.0.1")
    console.log("Only this machine can connect; pass --host with a private address to reach it.")
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve())
  })
  await server.close()
}
