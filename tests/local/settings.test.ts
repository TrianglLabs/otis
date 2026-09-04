import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  clearSelectedModel,
  loadLocalSettings,
  saveFastServingSelection,
  saveFireworksApiKey,
  saveFireworksSetup,
  savePairEndpoints,
  saveSelectedModel,
  saveSelectedTheme,
  saveThinkingVisible,
} from "../../src/local/settings.js"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("local settings", () => {
  it("stores a Fireworks key without replacing the selected local model", async () => {
    const file = join(await tempDirectory(), "config", "config.json")
    await saveSelectedModel(
      {
        provider: "local",
        id: "openai/gpt-oss-20b",
        displayName: "gpt-oss 20B",
        contextLength: 32_768,
        supportsImageInput: false,
      },
      { file },
    )

    await saveFireworksApiKey(" fw_test_key ", { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      fireworksApiKey: "fw_test_key",
      model: "openai/gpt-oss-20b",
      modelProvider: "local",
      modelContextLength: 32_768,
    })
  })

  it("stores the Fireworks key and selected model in a private local file", async () => {
    const file = join(await tempDirectory(), "config", "config.json")
    await saveFireworksSetup(" fw_test_key ", model("tool-model", "Tool Model", 131_072), { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toEqual({
      fireworksApiKey: "fw_test_key",
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
      modelProvider: "fireworks",
      modelSupportsImageInput: false,
    })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      fireworksApiKey: "fw_test_key",
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
      modelProvider: "fireworks",
      modelSupportsImageInput: false,
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
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
      modelProvider: "fireworks",
      modelSupportsImageInput: false,
    })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
      modelProvider: "fireworks",
      modelSupportsImageInput: false,
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
      modelProvider: "fireworks",
      modelSupportsImageInput: false,
    })
  })

  it("clears only the selected model fields", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveFireworksSetup("fw_test_key", model("tool-model", "Tool Model", 32_768), { file })
    await saveSelectedTheme("nord", { file })
    await saveThinkingVisible(true, { file })
    await saveFastServingSelection(model("tool-model", "Tool Model"), false, { file })

    await clearSelectedModel({ file })

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      fireworksApiKey: "fw_test_key",
      theme: "nord",
      thinkingVisible: true,
      fastServingModels: [],
    })
  })

  it("stores the selected theme without replacing provider settings", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveFireworksSetup("fw_test_key", model("tool-model", "Tool Model"), { file })
    await saveSelectedTheme("graphite", { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({ theme: "graphite" })
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      fireworksApiKey: "fw_test_key",
      theme: "graphite",
    })
  })

  it("stores thinking visibility independently from reasoning behavior", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveFireworksSetup("fw_test_key", model("tool-model", "Tool Model"), { file })
    await saveThinkingVisible(true, { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({ thinkingVisible: true })
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      fireworksApiKey: "fw_test_key",
      thinkingVisible: true,
    })
  })

  it("stores a model's Fast serving path without selecting it", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveSelectedModel(
      {
        provider: "fireworks",
        id: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        supportsImageInput: false,
        fastId: "accounts/fireworks/routers/kimi-k3-fast",
      },
      { file },
    )

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      model: "accounts/fireworks/models/kimi-k3",
      modelFastId: "accounts/fireworks/routers/kimi-k3-fast",
    })

    await saveSelectedModel(model("tool-model", "Tool Model"), { file })
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("modelFastId")
  })

  it("stores Fast serving preferences per model", async () => {
    const file = join(await tempDirectory(), "config.json")
    const alpha = fastModel("alpha", "Alpha")
    const beta = fastModel("beta", "Beta")
    await saveFireworksSetup("fw_test_key", alpha, { file })
    await saveFastServingSelection({ ...alpha, id: alpha.fastId }, true, { file })
    await saveFastServingSelection({ ...beta, id: beta.fastId }, true, { file })
    await saveFastServingSelection(alpha, false, { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      model: alpha.id,
      fastServingModels: [beta.id],
    })
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      fireworksApiKey: "fw_test_key",
      model: alpha.id,
      fastServingModels: [beta.id],
    })
  })

  it("migrates the released global Fast preference to the selected model", async () => {
    const file = join(await tempDirectory(), "config.json")
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        model: "accounts/fireworks/models/alpha",
        modelProvider: "fireworks",
        fastMode: true,
      }),
      "utf8",
    )

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      fastServingModels: ["accounts/fireworks/models/alpha"],
    })

    await saveSelectedModel(model("beta", "Beta"), { file })
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      model: "accounts/fireworks/models/beta",
      fastServingModels: ["accounts/fireworks/models/alpha"],
    })
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("fastMode")
  })

  it("loads and preserves permission policy while changing other settings", async () => {
    const file = join(await tempDirectory(), "config.json")
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        permissions: {
          defaultMode: "ask",
          rules: [{ tool: "bash", resource: "git status", effect: "allow" }],
        },
      }),
      "utf8",
    )

    await saveSelectedTheme("nord", { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      theme: "nord",
      permissions: {
        defaultMode: "ask",
        rules: [{ tool: "bash", resource: "git status", effect: "allow" }],
      },
    })
  })

  it("rejects malformed permission policy", async () => {
    const file = join(await tempDirectory(), "config.json")
    await writeFile(
      file,
      JSON.stringify({ version: 1, permissions: { rules: [{ tool: "bash", effect: "maybe" }] } }),
      "utf8",
    )
    await expect(loadLocalSettings({ file, env: {} })).rejects.toThrow("allow, ask, or deny")
  })

  it("stores a selected local model without clearing a saved Fireworks key", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveFireworksSetup("fw_test_key", model("tool-model", "Tool Model"), { file })
    await saveSelectedModel(
      {
        provider: "local",
        id: "openai/gpt-oss-20b",
        displayName: "gpt-oss 20B",
        contextLength: 32_768,
        supportsImageInput: false,
      },
      { file },
    )

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      fireworksApiKey: "fw_test_key",
      model: "openai/gpt-oss-20b",
      modelProvider: "local",
      modelContextLength: 32_768,
    })
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("modelFastId")
  })

  it("stores the selected PAIR engine and preserves configured endpoints across provider changes", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveFireworksSetup("fw_test_key", model("tool-model", "Tool Model"), { file })
    await saveSelectedModel(
      {
        provider: "pair",
        id: "qwen3.5:35b",
        displayName: "Qwen 3.5 35B",
        baseURL: "http://127.0.0.1:11434",
        engine: "ollama",
        nativeContextLength: 262_144,
        supportsImageInput: false,
      },
      { file },
    )

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      fireworksApiKey: "fw_test_key",
      pairEndpoints: { ollama: "http://127.0.0.1:11434" },
      pairEngine: "ollama",
      model: "qwen3.5:35b",
      modelProvider: "pair",
      modelContextLength: undefined,
    })
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("modelContextLength")

    await saveSelectedModel(model("hosted", "Hosted"), { file })
    const hostedSettings = await loadLocalSettings({ file, env: {} })
    expect(hostedSettings).toMatchObject({
      pairEndpoints: { ollama: "http://127.0.0.1:11434" },
      modelProvider: "fireworks",
    })
    expect(hostedSettings.pairEngine).toBeUndefined()
  })

  it("normalizes saved PAIR endpoints and rejects non-local addresses", async () => {
    const directory = await tempDirectory()
    const local = join(directory, "local.json")
    const remote = join(directory, "remote.json")
    await writeFile(
      local,
      JSON.stringify({ version: 1, pairEndpoints: { ollama: "http://localhost:11434/v1" } }),
      "utf8",
    )
    await writeFile(
      remote,
      JSON.stringify({ version: 1, pairEndpoints: { ollama: "http://192.168.1.10:11434" } }),
      "utf8",
    )

    await expect(loadLocalSettings({ file: local, env: {} })).resolves.toMatchObject({
      pairEndpoints: { ollama: "http://localhost:11434" },
    })
    await expect(loadLocalSettings({ file: remote, env: {} })).rejects.toThrow("Invalid Otis config")
  })

  it("stores every verified PAIR endpoint independently from the selected provider", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveSelectedModel(model("hosted", "Hosted"), { file })
    await savePairEndpoints({ ollama: "http://127.0.0.1:22111/v1", lmStudio: "http://127.0.0.1:22112" }, { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      pairEndpoints: {
        ollama: "http://127.0.0.1:22111",
        lmStudio: "http://127.0.0.1:22112",
      },
      modelProvider: "fireworks",
    })
  })

  it("rejects unreleased theme aliases", async () => {
    const directory = await tempDirectory()
    for (const alias of ["dark", "gray", "white"]) {
      const file = join(directory, `${alias}.json`)
      await writeFile(file, JSON.stringify({ version: 1, theme: alias }), "utf8")
      await expect(loadLocalSettings({ file, env: {} })).rejects.toThrow("theme must be")
    }
  })

  it("returns an empty configuration for a missing file", async () => {
    await expect(loadLocalSettings({ file: join(await tempDirectory(), "missing.json"), env: {} })).resolves.toEqual({
      fireworksApiKey: undefined,
      model: undefined,
      modelDisplayName: undefined,
      modelContextLength: undefined,
      modelSupportsImageInput: undefined,
    })
  })

  it("rejects malformed and unsupported configuration files", async () => {
    const directory = await tempDirectory()
    const malformed = join(directory, "malformed.json")
    const unsupported = join(directory, "unsupported.json")
    const invalidMetadata = join(directory, "invalid-metadata.json")
    const invalidTheme = join(directory, "invalid-theme.json")
    const invalidThinking = join(directory, "invalid-thinking.json")
    const invalidFastMode = join(directory, "invalid-fast-mode.json")
    const invalidFastServingModels = join(directory, "invalid-fast-serving-models.json")
    const invalidPairEndpoints = join(directory, "invalid-pair-endpoints.json")
    const invalidPairEngine = join(directory, "invalid-pair-engine.json")
    await writeFile(malformed, "{broken", "utf8")
    await writeFile(unsupported, JSON.stringify({ version: 2 }), "utf8")
    await writeFile(invalidMetadata, JSON.stringify({ version: 1, modelContextLength: -1 }), "utf8")
    await writeFile(invalidTheme, JSON.stringify({ version: 1, theme: "blue" }), "utf8")
    await writeFile(invalidThinking, JSON.stringify({ version: 1, thinkingVisible: "sometimes" }), "utf8")
    await writeFile(invalidFastMode, JSON.stringify({ version: 1, fastMode: "sometimes" }), "utf8")
    await writeFile(invalidFastServingModels, JSON.stringify({ version: 1, fastServingModels: [false] }), "utf8")
    await writeFile(invalidPairEndpoints, JSON.stringify({ version: 1, pairEndpoints: [] }), "utf8")
    await writeFile(invalidPairEngine, JSON.stringify({ version: 1, pairEngine: "llama.cpp" }), "utf8")

    await expect(loadLocalSettings({ file: malformed, env: {} })).rejects.toThrow("Invalid Otis config")
    await expect(loadLocalSettings({ file: unsupported, env: {} })).rejects.toThrow("unsupported version")
    await expect(loadLocalSettings({ file: invalidMetadata, env: {} })).rejects.toThrow("positive integer")
    await expect(loadLocalSettings({ file: invalidTheme, env: {} })).rejects.toThrow("theme must be")
    await expect(loadLocalSettings({ file: invalidThinking, env: {} })).rejects.toThrow("thinkingVisible must be")
    await expect(loadLocalSettings({ file: invalidFastMode, env: {} })).rejects.toThrow("fastMode must be")
    await expect(loadLocalSettings({ file: invalidFastServingModels, env: {} })).rejects.toThrow(
      "fastServingModels must be",
    )
    await expect(loadLocalSettings({ file: invalidPairEndpoints, env: {} })).rejects.toThrow(
      "pairEndpoints must be an object",
    )
    await expect(loadLocalSettings({ file: invalidPairEngine, env: {} })).rejects.toThrow(
      "pairEngine must be ollama or lmstudio",
    )
  })
})

async function tempDirectory() {
  const path = await mkdtemp(join(tmpdir(), "otis-settings-"))
  tempDirectories.push(path)
  return path
}

function model(name: string, displayName: string, contextLength?: number) {
  return {
    provider: "fireworks" as const,
    id: `accounts/fireworks/models/${name}`,
    displayName,
    supportsImageInput: false,
    ...(contextLength ? { contextLength } : {}),
  }
}

function fastModel(name: string, displayName: string) {
  return {
    ...model(name, displayName),
    fastId: `accounts/fireworks/routers/${name}-fast`,
  }
}
