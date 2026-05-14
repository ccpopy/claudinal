import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  listSidebarExpandedProjectIds,
  saveSidebarExpandedProjectIds
} from "./sidebarState"

class MemoryStorage {
  private data = new Map<string, string>()

  getItem(key: string) {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.data.set(key, value)
  }

  clear() {
    this.data.clear()
  }
}

describe("sidebarState", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage())
  })

  it("persists expanded project ids", () => {
    saveSidebarExpandedProjectIds(["p1", "p2"])

    expect(listSidebarExpandedProjectIds()).toEqual(["p1", "p2"])
  })

  it("deduplicates and ignores invalid project ids", () => {
    saveSidebarExpandedProjectIds(["p1", " ", "p1", "p2"])

    expect(listSidebarExpandedProjectIds()).toEqual(["p1", "p2"])
  })

  it("treats malformed stored values as empty state", () => {
    localStorage.setItem("claudinal.sidebar.expanded-projects", "{")

    expect(listSidebarExpandedProjectIds()).toEqual([])
  })
})
