import { describe, expect, it } from "vitest"
import { isTransientSessionIndexLockError } from "./sessionIndexError"

describe("isTransientSessionIndexLockError", () => {
  it.each([
    "sqlite: database is locked",
    "SQLite: database table is locked",
    new Error("sqlite: database is locked")
  ])("recognizes transient SQLite writer contention", (error) => {
    expect(isTransientSessionIndexLockError(error)).toBe(true)
  })

  it.each([
    "sqlite: database disk image is malformed",
    "database is locked",
    "session file not found"
  ])("does not hide non-lock failures", (error) => {
    expect(isTransientSessionIndexLockError(error)).toBe(false)
  })
})
