import { spawnSync } from "node:child_process"

/** Both projects are checked every time; a failure in one never hides errors in the other. */
const projects = ["tsconfig.json", "tsconfig.desktop-renderer.json"]
const failed = projects.filter(
  (project) =>
    spawnSync("tsc", ["--noEmit", "-p", project], { stdio: "inherit", shell: true }).status !== 0,
)
process.exit(failed.length === 0 ? 0 : 1)
