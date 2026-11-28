import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { createInterface } from "node:readline"
import { desktopCall } from "../desktop/main/api.js"
import { DesktopRuntime } from "../desktop/main/runtime.js"
import { resolveWorkspaceCwd } from "../desktop/main/workspace.js"
import {
  type ClientMessage,
  decode,
  encode,
  SERVE_PORT,
  type ServerMessage,
} from "../desktop/wire.js"
import { describeError } from "../inference/errors.js"
import { HOSTED_PROVIDER_INFO, isHostedProvider } from "../inference/types.js"
import { loadLocalSettings } from "../local/settings.js"
import { FEEDBACK_ADDRESS, feedbackEmail, openURL } from "./links.js"
import { checkForUpdate } from "./update.js"

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

/**
 * The runtime behind the terminal UI, which spawns it: the desktop API in this folder as
 * newline-delimited wire frames, calls on stdin and answers and events on stdout, until the UI
 * closes stdin.
 */
export async function runRpcCommand() {
  const write = (message: ServerMessage) => process.stdout.write(`${encode(message)}\n`)
  const version = process.env.OTIS_VERSION ?? "dev"
  const runtime = await DesktopRuntime.create({
    cwd: process.cwd(),
    version,
    platform: process.platform,
    terminal: true,
    send: (event) => write({ event }),
    notify: (notify) => write({ notify }),
    sendTerminal: () => {},
    spawnPty: () => {
      throw new Error("The terminal UI has no workspace shell.")
    },
  })
  const desktop = desktopCall(runtime)
  // The pages the desktop main opens with Electron's shell, opened here on the UI's machine, and
  // the release the terminal UI offers `otis update` for.
  const call = (method: string, args: unknown[]) => {
    if (method === "latestRelease") return checkForUpdate()
    if (method === "openHostedKeyPage") {
      if (!isHostedProvider(args[0])) throw new Error("Invalid hosted provider.")
      return openURL(HOSTED_PROVIDER_INFO[args[0]].keyURL)
    }
    if (method !== "sendFeedback") return desktop(method, args)
    return openURL(feedbackEmail(version, "terminal")).then((opened) => ({
      opened,
      address: FEEDBACK_ADDRESS,
    }))
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
  process.once("SIGTERM", () => lines.close())
  for await (const line of lines) {
    if (!line) continue
    const { id, method, args } = decode(line) as ClientMessage
    // As over the WebSocket: JSON has no undefined, so a null argument is an omitted one.
    const omitted = (args ?? []).map((arg) => arg ?? undefined)
    Promise.resolve()
      .then(() => call(method, omitted))
      .then(
        (result) => write({ id, result: result ?? null }),
        (error) => write({ id, error: describeError(error) }),
      )
  }
  await runtime.shutdown()
}
