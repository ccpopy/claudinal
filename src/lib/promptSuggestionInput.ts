/** The suggestion occupies only an untouched editor: any input, attachment or command hides it. */
export function visiblePromptSuggestion(input: {
  suggestion: string | null | undefined
  text: string
  attachments: number
  commandToken: string | null | undefined
  disabled: boolean
}): string | null {
  const suggestion = input.suggestion?.trim()
  if (!suggestion || input.text || input.attachments > 0 || input.commandToken || input.disabled) return null
  return suggestion
}
