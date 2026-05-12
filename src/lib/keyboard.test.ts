import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isEditableShortcutTarget } from "./keyboard"

class MockHTMLElement {
  readonly tagName: string
  readonly type: string
  readonly isContentEditable: boolean
  private readonly hasEditableAncestor: boolean

  constructor(
    tagName: string,
    options: {
      type?: string
      isContentEditable?: boolean
      hasEditableAncestor?: boolean
    } = {}
  ) {
    this.tagName = tagName.toUpperCase()
    this.type = options.type ?? "text"
    this.isContentEditable = options.isContentEditable ?? false
    this.hasEditableAncestor = options.hasEditableAncestor ?? false
  }

  closest(selector: string) {
    return selector === "[contenteditable='true']" && this.hasEditableAncestor
      ? this
      : null
  }
}

function element(
  tagName: string,
  options?: ConstructorParameters<typeof MockHTMLElement>[1]
) {
  return new MockHTMLElement(tagName, options) as unknown as HTMLElement
}

describe("keyboard", () => {
  beforeEach(() => {
    vi.stubGlobal("HTMLElement", MockHTMLElement)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("treats text editing controls as editable shortcut targets", () => {
    expect(isEditableShortcutTarget(element("textarea"))).toBe(true)
    expect(isEditableShortcutTarget(element("select"))).toBe(true)
    expect(isEditableShortcutTarget(element("input", { type: "text" }))).toBe(
      true
    )
  })

  it("does not treat button-like inputs as editable shortcut targets", () => {
    expect(isEditableShortcutTarget(element("input", { type: "button" }))).toBe(
      false
    )
    expect(isEditableShortcutTarget(element("input", { type: "checkbox" }))).toBe(
      false
    )
  })

  it("detects contenteditable targets and descendants", () => {
    expect(
      isEditableShortcutTarget(element("div", { isContentEditable: true }))
    ).toBe(true)
    expect(
      isEditableShortcutTarget(element("span", { hasEditableAncestor: true }))
    ).toBe(true)
  })

  it("ignores non-element event targets", () => {
    expect(isEditableShortcutTarget(null)).toBe(false)
  })
})
