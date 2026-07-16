import { startInteractiveCli } from "./interactive-cli.js"
import { runUpdateCommand } from "./update.js"

const version = process.env.OTIS_VERSION ?? "dev"

try {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case "update":
      await runUpdateCommand(args)
      break
    case "--version":
    case "-v":
    case "version":
      console.log(`otis ${version}`)
      break
    default:
      await startInteractiveCli()
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
