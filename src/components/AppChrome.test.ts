import { describe, expect, it } from "vitest"
import {
  titlebarDragThresholdReached,
  titlebarMouseDownAction
} from "./AppChrome"

describe("AppChrome titlebar interactions", () => {
  it("keeps dragging and double-click maximize mutually exclusive", () => {
    expect(titlebarMouseDownAction(0, 1, false)).toBe("prepare-drag")
    expect(titlebarMouseDownAction(0, 2, false)).toBe("toggle-maximize")
    expect(titlebarMouseDownAction(0, 3, false)).toBeNull()
  })

  it("does not treat interactive or non-primary clicks as titlebar input", () => {
    expect(titlebarMouseDownAction(0, 1, true)).toBeNull()
    expect(titlebarMouseDownAction(1, 1, false)).toBeNull()
    expect(titlebarMouseDownAction(2, 2, false)).toBeNull()
  })

  it("starts a drag only after primary-button movement reaches the threshold", () => {
    const origin = { x: 100, y: 100 }
    expect(titlebarDragThresholdReached(origin, { x: 102, y: 102 }, 1)).toBe(false)
    expect(titlebarDragThresholdReached(origin, { x: 103, y: 100 }, 1)).toBe(true)
    expect(titlebarDragThresholdReached(origin, { x: 110, y: 110 }, 0)).toBe(false)
  })
})
