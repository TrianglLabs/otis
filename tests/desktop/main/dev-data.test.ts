import { describe, expect, it } from "vitest"
import { resolveDevData } from "../../../src/desktop/main/dev-data.js"

describe("resolveDevData", () => {
  it("returns undefined when the build is packaged", () => {
    expect(resolveDevData({ packaged: true, otisDevUserData: "/tmp/otis-dev", otisHome: undefined })).toBeUndefined()
  })

  it("returns undefined when OTIS_DEV_USER_DATA is unset or blank", () => {
    expect(resolveDevData({ packaged: false, otisDevUserData: undefined, otisHome: undefined })).toBeUndefined()
    expect(resolveDevData({ packaged: false, otisDevUserData: "  ", otisHome: undefined })).toBeUndefined()
  })

  it("sandboxes userData and defaults the Otis data root to the same directory", () => {
    expect(resolveDevData({ packaged: false, otisDevUserData: "/tmp/otis-dev", otisHome: undefined })).toEqual({
      userData: "/tmp/otis-dev",
      otisHome: "/tmp/otis-dev",
    })
  })

  it("keeps an explicit OTIS_HOME so a sandbox can be shaped differently", () => {
    expect(
      resolveDevData({ packaged: false, otisDevUserData: "/tmp/otis-dev", otisHome: "/tmp/otis-dev-home" }),
    ).toEqual({ userData: "/tmp/otis-dev", otisHome: "/tmp/otis-dev-home" })
  })

  it("treats a blank OTIS_HOME as unset and falls back to the sandbox", () => {
    expect(resolveDevData({ packaged: false, otisDevUserData: "/tmp/otis-dev", otisHome: "   " })).toEqual({
      userData: "/tmp/otis-dev",
      otisHome: "/tmp/otis-dev",
    })
  })

  it("trims the sandbox path so stray whitespace can't fork the isolation", () => {
    expect(resolveDevData({ packaged: false, otisDevUserData: "  /tmp/otis-dev  ", otisHome: undefined })).toEqual({
      userData: "/tmp/otis-dev",
      otisHome: "/tmp/otis-dev",
    })
  })
})
