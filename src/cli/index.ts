import { runHeadlessCommand } from "./headless-cli.js"
import { runSkillsCommand } from "./skills-cli.js"
import { runUpdateCommand } from "./update.js"

const version = process.env.OTIS_VERSION ?? "dev"

try {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case "update":
      await runUpdateCommand(args)
      break
    case "exec":
      process.exitCode = await runHeadlessCommand(args)
      break
    case "skills":
      await runSkillsCommand(args)
      break
    case "--version":
    case "-v":
    case "version":
      console.log(`otis ${version}`)
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
