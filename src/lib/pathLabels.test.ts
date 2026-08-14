import { describe, expect, it } from "vitest"
import { shortestUniquePathLabels } from "./pathLabels"

describe("shortestUniquePathLabels", () => {
  it("keeps unique basenames compact", () => {
    expect(shortestUniquePathLabels(["src/App.tsx", "src/main.tsx"])).toEqual([
      "App.tsx",
      "main.tsx"
    ])
  })

  it("adds as many parent segments as duplicate trees require", () => {
    expect(
      shortestUniquePathLabels([
        "packages/a/src/index.ts",
        "packages/b/src/index.ts",
        "packages/b/test/index.ts"
      ])
    ).toEqual(["a/src/index.ts", "b/src/index.ts", "test/index.ts"])
  })

  it("handles Windows separators", () => {
    expect(shortestUniquePathLabels(["src\\a\\mod.rs", "src\\b\\mod.rs"])).toEqual([
      "a/mod.rs",
      "b/mod.rs"
    ])
  })

  it("adds stable occurrence labels for identical paths", () => {
    expect(shortestUniquePathLabels(["src/App.tsx", "src/App.tsx"])).toEqual([
      "src/App.tsx (1)",
      "src/App.tsx (2)"
    ])
  })
})
