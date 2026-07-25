import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  loadLocalSettings,
  saveFireworksSetup,
  saveParallelApiKey,
  saveSelectedModel,
  saveSelectedTheme,
} from "../../src/local/settings.js"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("local settings", () => {
  it("stores the Fireworks key and selected model in a private local file", async () => {
    const file = join(await tempDirectory(), "config", "config.json")
    await saveFireworksSetup(" fw_test_key ", model("tool-model", "Tool Model", 131_072), { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toEqual({
      fireworksApiKey: "fw_test_key",
      parallelApiKey: undefined,
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
    })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      fireworksApiKey: "fw_test_key",
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
    })
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect((await stat(join(file, ".."))).mode & 0o777).toBe(0o700)
    }
  })

  it("uses FIREWORKS_API_KEY without copying it into a model-only config", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveSelectedModel(model("tool-model", "Tool Model", 131_072), { file })

    await expect(loadLocalSettings({ file, env: { FIREWORKS_API_KEY: " fw_env_key " } })).resolves.toEqual({
      fireworksApiKey: "fw_env_key",
      parallelApiKey: undefined,
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
    })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
    })
  })

  it("changes the selected model without replacing a saved key", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveFireworksSetup("fw_test_key", model("old", "Old", 32_768), { file })
    await saveSelectedModel(model("new", "New"), { file })

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      fireworksApiKey: "fw_test_key",
      model: "accounts/fireworks/models/new",
      modelDisplayName: "New",
    })
  })

  it("stores a Parallel key without replacing Fireworks settings", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveFireworksSetup("fw_test_key", model("tool-model", "Tool Model", 131_072), { file })
    await saveParallelApiKey(" parallel_test_key ", { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toEqual({
      fireworksApiKey: "fw_test_key",
      parallelApiKey: "parallel_test_key",
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
    })
  })

  it("stores the selected theme without replacing provider settings", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveFireworksSetup("fw_test_key", model("tool-model", "Tool Model"), { file })
    await saveSelectedTheme("bright", { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({ theme: "bright" })
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      fireworksApiKey: "fw_test_key",
      theme: "bright",
    })
  })

  it("rejects unreleased theme aliases", async () => {
    const directory = await tempDirectory()
    for (const alias of ["dark", "midnight", "gray", "white"]) {
      const file = join(directory, `${alias}.json`)
      await writeFile(file, JSON.stringify({ version: 1, theme: alias }), "utf8")
      await expect(loadLocalSettings({ file, env: {} })).rejects.toThrow("theme must be")
    }
  })

  it("uses provider environment keys without persisting either secret", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveSelectedModel(model("tool-model", "Tool Model", 131_072), { file })

    await expect(
      loadLocalSettings({
        file,
        env: { FIREWORKS_API_KEY: " fw_env_key ", PARALLEL_API_KEY: " parallel_env_key " },
      }),
    ).resolves.toMatchObject({
      fireworksApiKey: "fw_env_key",
      parallelApiKey: "parallel_env_key",
    })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
    })
  })

  it("returns an empty configuration for a missing file", async () => {
    await expect(loadLocalSettings({ file: join(await tempDirectory(), "missing.json"), env: {} })).resolves.toEqual({
      fireworksApiKey: undefined,
      parallelApiKey: undefined,
      model: undefined,
      modelDisplayName: undefined,
      modelContextLength: undefined,
    })
  })

  it("rejects malformed and unsupported configuration files", async () => {
    const directory = await tempDirectory()
    const malformed = join(directory, "malformed.json")
    const unsupported = join(directory, "unsupported.json")
    const invalidMetadata = join(directory, "invalid-metadata.json")
    const invalidTheme = join(directory, "invalid-theme.json")
    await writeFile(malformed, "{broken", "utf8")
    await writeFile(unsupported, JSON.stringify({ version: 2 }), "utf8")
    await writeFile(invalidMetadata, JSON.stringify({ version: 1, modelContextLength: -1 }), "utf8")
    await writeFile(invalidTheme, JSON.stringify({ version: 1, theme: "blue" }), "utf8")

    await expect(loadLocalSettings({ file: malformed, env: {} })).rejects.toThrow("Invalid Otis config")
    await expect(loadLocalSettings({ file: unsupported, env: {} })).rejects.toThrow("unsupported version")
    await expect(loadLocalSettings({ file: invalidMetadata, env: {} })).rejects.toThrow("positive integer")
    await expect(loadLocalSettings({ file: invalidTheme, env: {} })).rejects.toThrow("theme must be")
  })
})

async function tempDirectory() {
  const path = await mkdtemp(join(tmpdir(), "otis-settings-"))
  tempDirectories.push(path)
  return path
}

function model(name: string, displayName: string, contextLength?: number) {
  return {
    id: `accounts/fireworks/models/${name}`,
    displayName,
    ...(contextLength ? { contextLength } : {}),
  }
}
