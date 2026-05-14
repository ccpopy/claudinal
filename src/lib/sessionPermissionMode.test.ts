import { describe, expect, it } from "vitest"
import {
  isPermissionMode,
  mergeSidecarPermissionMode,
  pickPermissionModeFromSidecar
} from "./sessionPermissionMode"

describe("sessionPermissionMode", () => {
  it("accepts only supported Claude permission modes", () => {
    expect(isPermissionMode("default")).toBe(true)
    expect(isPermissionMode("acceptEdits")).toBe(true)
    expect(isPermissionMode("plan")).toBe(true)
    expect(isPermissionMode("bypassPermissions")).toBe(true)
    expect(isPermissionMode("dontAsk")).toBe(false)
    expect(isPermissionMode(null)).toBe(false)
  })

  it("reads session permission override from sidecar", () => {
    expect(pickPermissionModeFromSidecar(null)).toBeNull()
    expect(pickPermissionModeFromSidecar({ permissionMode: "acceptEdits" })).toBe(
      "acceptEdits"
    )
    expect(pickPermissionModeFromSidecar({ permissionMode: "dontAsk" })).toBeNull()
  })

  it("merges and clears permission mode without dropping other sidecar fields", () => {
    const existing = { result: { type: "result" }, composer: { effort: "high" } }
    expect(mergeSidecarPermissionMode(existing, "plan")).toEqual({
      result: { type: "result" },
      composer: { effort: "high" },
      permissionMode: "plan"
    })
    expect(
      mergeSidecarPermissionMode(
        { ...existing, permissionMode: "bypassPermissions" },
        null
      )
    ).toEqual(existing)
  })
})
