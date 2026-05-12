export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tagName = target.tagName.toLowerCase()
  if (tagName === "textarea" || tagName === "select") return true
  if (tagName === "input") {
    const type = (target as HTMLInputElement).type.toLowerCase()
    return !["button", "checkbox", "radio", "range", "reset", "submit"].includes(
      type
    )
  }
  return !!target.closest("[contenteditable='true']")
}
