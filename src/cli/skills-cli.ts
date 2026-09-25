import type { ManagedSkillSource } from "../skills/catalog.js"
import { SkillManager } from "../skills/manager.js"
export async function runSkillsCommand(
  args: string[],
  options: { manager?: SkillManager; stdout?: { write(chunk: string): unknown } } = {},
) {
  const manager = options.manager ?? new SkillManager()
  const stdout = options.stdout ?? process.stdout
  const [command, ...commandArgs] = args

  if (!command || command === "help" || command === "--help" || command === "-h") {
    stdout.write(SKILLS_HELP)
    return
  }

  if (command === "install") {
    let name: string | undefined
    let url: string | undefined
    for (let index = 0; index < commandArgs.length; index += 1) {
      const argument = commandArgs[index]
      if (argument === "--name") {
        name = commandArgs[index + 1]
        if (!name) throw new Error("Missing value for --name.")
        index += 1
      } else if (argument.startsWith("--name=")) {
        name = argument.slice("--name=".length)
      } else if (argument.startsWith("-")) {
        throw new Error(`Unknown skills install option: ${argument}`)
      } else if (url) {
        throw new Error("skills install accepts exactly one Git URL.")
      } else {
        url = argument
      }
    }
    if (!url) throw new Error("Usage: otis skills install <git-url> [--name NAME]")
    const source = await manager.install(url, name)
    stdout.write(`Installed ${formatSource(source)}\nRestart Otis to load the new skills.\n`)
    return
  }

  if (command === "list") {
    if (commandArgs.length > 0) throw new Error(`skills ${command} does not accept arguments.`)
    const sources = await manager.list()
    if (sources.length === 0) {
      stdout.write("No Otis-managed skill sources are installed.\n")
      return
    }
    for (const source of sources) stdout.write(`${formatSource(source)}\n  ${source.url}\n`)
    return
  }

  if (command === "update") {
    if (commandArgs.length > 1)
      throw new Error(`skills ${command} accepts at most one source name.`)
    if (commandArgs[0]?.startsWith("-"))
      throw new Error(`Unknown skills ${command} option: ${commandArgs[0]}`)
    const sources = await manager.update(commandArgs[0])
    if (sources.length === 0) {
      stdout.write("No Otis-managed skill sources are installed.\n")
      return
    }
    for (const source of sources) stdout.write(`Updated ${formatSource(source)}\n`)
    stdout.write("Restart Otis to load the updated skills.\n")
    return
  }

  if (command === "remove") {
    if (commandArgs.length !== 1 || commandArgs[0]?.startsWith("-")) {
      throw new Error(`Usage: otis skills ${command} <source-name>`)
    }
    const source = await manager.remove(commandArgs[0])
    stdout.write(`Removed ${source.id} and ${skillCount(source.skills.length)}.\n`)
    return
  }

  throw new Error(`Unknown skills command: ${command}\n\n${SKILLS_HELP}`)
}

export function formatSource(source: ManagedSkillSource) {
  const names = source.skills.map((skill) => skill.name).join(", ")
  return `${source.id} (${skillCount(source.skills.length)}: ${names})`
}

export function skillCount(count: number) {
  return `${count} skill${count === 1 ? "" : "s"}`
}

const SKILLS_HELP = `Usage: otis skills <command>

Manage Git-backed Agent Skills without starting OpenTUI.

Commands:
  install <git-url> [--name NAME]  Install and activate skills from a Git repository, or from
                                    one folder of it (…/tree/<branch>/<folder>)
  list                              List sources managed by Otis
  update [source-name]              Fast-forward one source, or all installed sources
  remove <source-name>              Remove a source and its Otis-managed activations
`
