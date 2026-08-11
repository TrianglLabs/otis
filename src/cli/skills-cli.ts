import { type ManagedSkillSource, SkillManager } from "../skills/index.js"

type Writable = { write(chunk: string): unknown }

export type RunSkillsCommandOptions = {
  manager?: SkillManager
  stdout?: Writable
}

export async function runSkillsCommand(args: string[], options: RunSkillsCommandOptions = {}) {
  const manager = options.manager ?? new SkillManager()
  const stdout = options.stdout ?? process.stdout
  const [command, ...commandArgs] = args

  if (!command || command === "help" || command === "--help" || command === "-h") {
    stdout.write(SKILLS_HELP)
    return
  }

  if (command === "install") {
    const parsed = parseInstallArgs(commandArgs)
    const source = await manager.install(parsed.url, parsed.name)
    stdout.write(`Installed ${formatSource(source)}\nRestart Otis to load the new skills.\n`)
    return
  }

  if (command === "list") {
    noArguments(command, commandArgs)
    const sources = await manager.list()
    if (sources.length === 0) {
      stdout.write("No Otis-managed skill sources are installed.\n")
      return
    }
    for (const source of sources) stdout.write(`${formatSource(source)}\n  ${source.url}\n`)
    return
  }

  if (command === "update") {
    atMostOneArgument(command, commandArgs)
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
    exactlyOneArgument(command, commandArgs)
    const source = await manager.remove(commandArgs[0])
    stdout.write(
      `Removed ${source.id} and ${source.skills.length} managed skill${source.skills.length === 1 ? "" : "s"}.\n`,
    )
    return
  }

  throw new Error(`Unknown skills command: ${command}\n\n${SKILLS_HELP}`)
}

function parseInstallArgs(args: string[]) {
  let name: string | undefined
  let url: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--name") {
      name = args[index + 1]
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
  return { url, name }
}

function formatSource(source: ManagedSkillSource) {
  const names = source.skills.map((skill) => skill.name).join(", ")
  return `${source.id} (${source.skills.length} skill${source.skills.length === 1 ? "" : "s"}: ${names})`
}

function noArguments(command: string, args: string[]) {
  if (args.length > 0) throw new Error(`skills ${command} does not accept arguments.`)
}

function atMostOneArgument(command: string, args: string[]) {
  if (args.length > 1) throw new Error(`skills ${command} accepts at most one source name.`)
  if (args[0]?.startsWith("-")) throw new Error(`Unknown skills ${command} option: ${args[0]}`)
}

function exactlyOneArgument(command: string, args: string[]) {
  if (args.length !== 1 || args[0]?.startsWith("-")) {
    throw new Error(`Usage: otis skills ${command} <source-name>`)
  }
}

const SKILLS_HELP = `Usage: otis skills <command>

Manage Git-backed Agent Skills without starting OpenTUI.

Commands:
  install <git-url> [--name NAME]  Install and activate skills from a Git repository
  list                              List sources managed by Otis
  update [source-name]              Fast-forward one source, or all installed sources
  remove <source-name>              Remove a source and its Otis-managed activations
`
