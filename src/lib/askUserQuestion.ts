import type { PermissionRequestPayload } from "@/lib/ipc"

export const ASK_USER_QUESTION_TOOL = "AskUserQuestion"

export interface AskUserQuestionOption {
  label: string
  description?: string
  preview?: string
}

export interface AskUserQuestionItem {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect: boolean
}

export interface AskUserQuestionInput {
  questions: AskUserQuestionItem[]
  [key: string]: unknown
}

export type AskUserQuestionAnswer = string | string[]
export type AskUserQuestionAnswers = Record<string, AskUserQuestionAnswer>

export interface AskUserQuestionDraftAnswer {
  selected: string[]
  custom: string
}

export type AskUserQuestionDraftAnswers = Record<
  number,
  AskUserQuestionDraftAnswer
>

export function isAskUserQuestionRequest(
  request: PermissionRequestPayload | null
): boolean {
  const toolName = request?.request.tool_name ?? request?.request.display_name
  return toolName === ASK_USER_QUESTION_TOOL
}

export function parseAskUserQuestionInput(
  input: unknown
): AskUserQuestionInput {
  if (!isRecord(input)) {
    throw new Error("AskUserQuestion 输入必须是对象")
  }

  const questions = input.questions
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) {
    throw new Error("AskUserQuestion 必须包含 1 到 4 个问题")
  }

  return {
    ...input,
    questions: questions.map(parseQuestion)
  }
}

export function buildAskUserQuestionResponse(
  input: AskUserQuestionInput,
  answers: AskUserQuestionAnswers
): Record<string, unknown> {
  return {
    behavior: "allow",
    updatedInput: {
      ...input,
      questions: input.questions,
      answers
    }
  }
}

export function initialAskUserQuestionDraft(
  input: AskUserQuestionInput
): AskUserQuestionDraftAnswers {
  return Object.fromEntries(
    input.questions.map((_, index) => [index, { selected: [], custom: "" }])
  )
}

export function updateAskUserQuestionSelection(
  draft: AskUserQuestionDraftAnswers,
  questionIndex: number,
  label: string,
  multiSelect: boolean
): AskUserQuestionDraftAnswers {
  const current = draft[questionIndex] ?? emptyDraftAnswer()
  if (multiSelect) {
    const selected = current.selected.includes(label)
      ? current.selected.filter((item) => item !== label)
      : [...current.selected, label]
    return {
      ...draft,
      [questionIndex]: { ...current, selected }
    }
  }

  return {
    ...draft,
    [questionIndex]: {
      selected: current.selected.includes(label) ? [] : [label],
      custom: current.custom
    }
  }
}

export function updateAskUserQuestionCustomAnswer(
  draft: AskUserQuestionDraftAnswers,
  questionIndex: number,
  custom: string,
  multiSelect: boolean
): AskUserQuestionDraftAnswers {
  const current = draft[questionIndex] ?? emptyDraftAnswer()
  return {
    ...draft,
    [questionIndex]: {
      ...current,
      selected: !multiSelect && custom.trim() ? [] : current.selected,
      custom
    }
  }
}

export function collectAskUserQuestionAnswers(
  input: AskUserQuestionInput,
  draft: AskUserQuestionDraftAnswers
): AskUserQuestionAnswers | null {
  const answers: AskUserQuestionAnswers = {}
  for (let index = 0; index < input.questions.length; index += 1) {
    const question = input.questions[index]
    const current = draft[index] ?? emptyDraftAnswer()
    const custom = current.custom.trim()
    if (question.multiSelect) {
      const selected = custom ? [...current.selected, custom] : current.selected
      if (selected.length === 0) return null
      answers[question.question] = selected
      continue
    }
    if (current.selected.length === 1) {
      answers[question.question] = current.selected[0]
      continue
    }
    if (current.selected.length > 1) return null
    if (!custom) return null
    answers[question.question] = custom
    continue
  }
  return answers
}

export function isAskUserQuestionAnswerComplete(
  question: AskUserQuestionItem,
  answer: AskUserQuestionDraftAnswer | undefined
): boolean {
  const current = answer ?? emptyDraftAnswer()
  const custom = current.custom.trim()
  if (question.multiSelect) {
    return current.selected.length > 0 || custom.length > 0
  }
  if (current.selected.length === 1) return true
  if (current.selected.length > 1) return false
  return custom.length > 0
}

function parseQuestion(value: unknown, index: number): AskUserQuestionItem {
  if (!isRecord(value)) {
    throw new Error(`第 ${index + 1} 个问题必须是对象`)
  }
  const question = requiredString(value.question, `第 ${index + 1} 个问题缺少 question`)
  const header = requiredString(value.header, `问题「${question}」缺少 header`)
  const options = value.options
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
    throw new Error(`问题「${question}」必须包含 2 到 4 个选项`)
  }
  return {
    question,
    header,
    options: options.map((option, optionIndex) =>
      parseOption(option, question, optionIndex)
    ),
    multiSelect: value.multiSelect === true
  }
}

function parseOption(
  value: unknown,
  question: string,
  index: number
): AskUserQuestionOption {
  if (!isRecord(value)) {
    throw new Error(`问题「${question}」的第 ${index + 1} 个选项必须是对象`)
  }
  const label = requiredString(
    value.label,
    `问题「${question}」的第 ${index + 1} 个选项缺少 label`
  )
  const description = optionalString(
    value.description,
    `选项「${label}」的 description 必须是字符串`
  )
  const option: AskUserQuestionOption = description
    ? { label, description }
    : { label }
  if (typeof value.preview === "string" && value.preview.trim()) {
    option.preview = value.preview
  }
  return option
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message)
  }
  return value.trim()
}

function optionalString(value: unknown, message: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== "string") {
    throw new Error(message)
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

function emptyDraftAnswer(): AskUserQuestionDraftAnswer {
  return { selected: [], custom: "" }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
