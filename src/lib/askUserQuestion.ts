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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
