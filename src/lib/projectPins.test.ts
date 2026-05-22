import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  isProjectPinned,
  listPinnedProjects,
  pinProject,
  prunePinnedProjects,
  toggleProjectPin
} from "./projectPins"

class MemoryStorage {
  private data = new Map<string, string>()

  getItem(key: string) {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.data.set(key, value)
  }
}

describe("projectPins", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal("localStorage", new MemoryStorage())
  })

  it("persists pinned projects ordered by latest pin", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(200)

    pinProject("p1")
    pinProject("p2")

    expect(listPinnedProjects()).toEqual([
      { projectId: "p2", pinnedAt: 200 },
      { projectId: "p1", pinnedAt: 100 }
    ])
  })

  it("toggles project pins", () => {
    vi.spyOn(Date, "now").mockReturnValue(100)

    expect(toggleProjectPin("p1")).toBe(true)
    expect(isProjectPinned("p1")).toBe(true)
    expect(toggleProjectPin("p1")).toBe(false)
    expect(isProjectPinned("p1")).toBe(false)
  })

  it("prunes pins for projects that no longer exist", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(200)
    pinProject("p1")
    pinProject("p2")

    expect(prunePinnedProjects(["p2"])).toEqual([
      { projectId: "p2", pinnedAt: 200 }
    ])
    expect(listPinnedProjects()).toEqual([{ projectId: "p2", pinnedAt: 200 }])
  })

  it("treats malformed stored values as empty state", () => {
    localStorage.setItem("claudinal.pinned-projects", "{")

    expect(listPinnedProjects()).toEqual([])
  })
})
