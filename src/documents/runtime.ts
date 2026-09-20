import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { localDataDirectory } from "../local/paths.js"
import requirements from "../skills/bundled/documents/requirements.txt" with { type: "text" }
import { type DocumentProcessRunner, runDocumentProcess } from "./process.js"

const revision = createHash("sha256").update(requirements).digest("hex").slice(0, 20)
const packages = Object.fromEntries(
  requirements
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("==")),
)
const probe = [
  "import importlib, importlib.metadata as m, json, sys, shutil, os",
  `expected = ${JSON.stringify(packages)}`,
  "missing = []",
  "for name, version in expected.items():",
  "    try:",
  "        if m.version(name) != version: missing.append(name + '==' + version)",
  "    except m.PackageNotFoundError: missing.append(name + '==' + version)",
  "if not missing:",
  "    for name in ['docx', 'reportlab', 'pypdf', 'pypdfium2', 'PIL.Image']:",
  "        try: importlib.import_module(name)",
  "        except Exception: missing.append(name)",
  "office = shutil.which('soffice') or shutil.which('libreoffice') or (os.path.isfile('/Applications/LibreOffice.app/Contents/MacOS/soffice') and '/Applications/LibreOffice.app/Contents/MacOS/soffice')",
  "print(json.dumps({'python': sys.executable, 'version': list(sys.version_info[:3]), 'missing': missing, 'libreoffice': bool(office)}))",
].join("\n")

type Probe = { python: string; version: number[]; missing: string[]; libreoffice: boolean }
export type DocumentRuntimeOptions = { dataDirectory?: string; signal?: AbortSignal }

function locations(options: DocumentRuntimeOptions) {
  const root = join(resolve(options.dataDirectory ?? localDataDirectory()), "document-runtime")
  const environment = join(root, revision)
  return {
    root,
    environment,
    python: join(environment, process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
  }
}

async function inspect(
  python: string,
  cwd: string,
  signal: AbortSignal | undefined,
  run: DocumentProcessRunner,
): Promise<Probe | undefined> {
  try {
    const value = JSON.parse(await run(python, ["-I", "-B", "-c", probe], { cwd, signal, timeoutMs: 10_000 })) as Probe
    if (
      typeof value.python === "string" &&
      Array.isArray(value.version) &&
      value.version[0] === 3 &&
      value.version[1] >= 10 &&
      Array.isArray(value.missing)
    )
      return value
  } catch {
    signal?.throwIfAborted()
  }
  return undefined
}

async function findPython(signal: AbortSignal | undefined, run: DocumentProcessRunner) {
  const candidates = ["python3", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python"]
  if (process.platform === "darwin") candidates.push("/opt/homebrew/bin/python3", "/usr/local/bin/python3")
  for (const candidate of candidates) {
    const result = await inspect(candidate, process.cwd(), signal, run)
    if (result) return result
  }
  if (process.platform === "win32") {
    try {
      const path = (
        await run("py", ["-3", "-I", "-c", "import sys; print(sys.executable)"], {
          cwd: process.cwd(),
          signal,
          timeoutMs: 10_000,
        })
      ).trim()
      const result = await inspect(path, process.cwd(), signal, run)
      if (result) return result
    } catch {
      signal?.throwIfAborted()
    }
  }
  return undefined
}

/** Reports readiness without creating an environment or accessing the network. */
export async function checkDocumentRuntime(
  options: DocumentRuntimeOptions,
  run: DocumentProcessRunner = runDocumentProcess,
) {
  const paths = locations(options)
  await assertManagedDirectories(paths, false)
  const cached = await inspect(paths.python, dirname(paths.root), options.signal, run)
  const python = cached ?? (await findPython(options.signal, run))
  return {
    ready: Boolean(cached && cached.missing.length === 0),
    python: python?.python ?? null,
    python_version: python?.version.join(".") ?? null,
    libreoffice: python?.libreoffice ?? false,
    missing_packages: cached?.missing ?? Object.keys(packages),
    ...(!python
      ? {
          reason:
            "Python 3.10 or later is required. Install Python and restart Otis; document packages are prepared automatically.",
        }
      : {}),
  }
}

/** One immutable dependency version per data root, shared by terminal, desktop and headless workspaces. */
export async function ensureDocumentRuntime(
  options: DocumentRuntimeOptions,
  requirementsPath: string,
  run: DocumentProcessRunner = runDocumentProcess,
) {
  const paths = locations(options)
  await assertManagedDirectories(paths, true)
  const release = await acquireSetupLock(paths.root, options.signal)
  try {
    const cached = await inspect(paths.python, paths.root, options.signal, run)
    if (cached && cached.missing.length === 0) return paths.python
    const python = await findPython(options.signal, run)
    if (!python)
      throw new Error(
        "Python 3.10 or later is required. Install Python and restart Otis; document packages are prepared automatically.",
      )
    options.signal?.throwIfAborted()
    // Failed or interrupted setup is rebuilt. Never rename a venv: its interpreter paths are absolute.
    await rm(paths.environment, { recursive: true, force: true })
    await mkdir(paths.environment, { mode: 0o700 })
    try {
      await run(python.python, ["-I", "-m", "venv", paths.environment], { cwd: paths.root, signal: options.signal })
      await run(
        paths.python,
        [
          "-I",
          "-m",
          "pip",
          "--isolated",
          "--disable-pip-version-check",
          "--no-input",
          "install",
          "--only-binary=:all:",
          "--index-url",
          "https://pypi.org/simple",
          "--no-deps",
          "-r",
          requirementsPath,
        ],
        { cwd: paths.root, signal: options.signal },
      )
      await run(paths.python, ["-I", "-m", "pip", "--isolated", "check"], {
        cwd: paths.root,
        signal: options.signal,
        timeoutMs: 15_000,
      })
      const verified = await inspect(paths.python, paths.root, options.signal, run)
      if (!verified || verified.missing.length) throw new Error("Installed document dependencies failed verification.")
      return paths.python
    } catch (error) {
      await rm(paths.environment, { recursive: true, force: true })
      throw new Error(
        "Could not prepare document dependencies. Retry the document operation after resolving the error. " +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      )
    }
  } finally {
    await release()
  }
}

async function assertManagedDirectories(paths: ReturnType<typeof locations>, create: boolean) {
  if (create) await mkdir(dirname(paths.root), { recursive: true, mode: 0o700 })
  for (const path of [paths.root, paths.environment]) {
    if (create && path === paths.root)
      await mkdir(path, { mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST") throw error
      })
    try {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Document runtime directory must not be a symlink: ${path}`)
      if (create && process.platform !== "win32") await chmod(path, 0o700)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
  }
}

async function acquireSetupLock(root: string, signal?: AbortSignal) {
  const path = join(await realpath(root), "setup.lock")
  const token = randomUUID()
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    try {
      const handle = await open(path, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }))
      } finally {
        await handle.close()
      }
      return async () => {
        if (JSON.parse(await readFile(path, "utf8")).token === token) await rm(path)
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      const info = await lstat(path).catch((error) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!info) continue
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid document setup lock.")
      let stale = false
      try {
        const owner = JSON.parse(await readFile(path, "utf8")) as { pid?: number }
        if (!Number.isInteger(owner.pid) || (owner.pid ?? 0) <= 0) throw new Error("Incomplete lock")
        try {
          process.kill(owner.pid as number, 0)
        } catch (error) {
          stale = error instanceof Error && "code" in error && error.code === "ESRCH"
        }
      } catch {
        const current = await stat(path).catch((error) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (!current) continue
        stale = Date.now() - current.mtimeMs > 30_000
      }
      if (stale) await rm(path, { force: true })
      else await delay(150, undefined, { signal })
    }
  }
  throw new Error("Another Otis process is preparing document dependencies. Retry when it finishes.")
}
