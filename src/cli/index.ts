import { Console } from "node:console"
import { runHeadlessCommand } from "./headless-cli.js"
import { runSkillsCommand } from "./skills-cli.js"
import { runUpdateCommand } from "./update.js"

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
      const { InteractiveApp } = await import("./interactive-app.js")
      await InteractiveApp.start()
    }
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
