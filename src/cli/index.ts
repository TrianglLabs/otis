import { Console } from "node:console"
import { describeError } from "../inference/errors.js"
import { runHeadlessCommand } from "./headless-cli.js"
import { runSkillsCommand } from "./skills-cli.js"
import { runUpdateCommand } from "./update.js"

// A crash must not orphan a multi-gigabyte llama-server. Both the interactive app and headless
// runs shut down on SIGTERM through their own quit paths, which stop the managed server; raise
// that in-process, then exit with the original error once the loop drains or a deadline passes.
const crash = (error: unknown) => {
  process.off("uncaughtException", crash)
  process.off("unhandledRejection", crash)
  process.exitCode = 1
  process.once("exit", () => {
    process.exitCode = 1
    console.error(error)
  })
  setTimeout(() => process.exit(), 10_000).unref()
  process.emit("SIGTERM", "SIGTERM")
}
process.on("uncaughtException", crash)
process.on("unhandledRejection", crash)

try {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case "update":
      await runUpdateCommand(args)
      break
    case "exec":
      // Headless stdout is a protocol owned by the reporter; library diagnostics belong on stderr.
      globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })
      process.exitCode = await runHeadlessCommand(args)
      break
    case "skills":
      await runSkillsCommand(args)
      break
    case "--version":
    case "-v":
    case "version":
      console.log(`otis ${process.env.OTIS_VERSION ?? "dev"}`)
      break
    default: {
      // A desktop launcher or a pipe has no terminal: the TUI would draw into nothing and wait
      // forever. Refuse before any settings, sessions or managed runtimes load.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          "otis needs an interactive terminal. Run it from a terminal, or use `otis exec` " +
            "for scripts.",
        )
      }
      const { InteractiveApp } = await import("./interactive-app.js")
      await InteractiveApp.start()
    }
  }
} catch (error) {
  console.error(`Error: ${describeError(error)}`)
  process.exitCode = 1
}
