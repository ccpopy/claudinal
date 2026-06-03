import { describe, expect, it } from "vitest"
import type { PermissionRequestPayload } from "./ipc"
import {
  buildAskUserQuestionResponse,
  collectAskUserQuestionAnswers,
  initialAskUserQuestionDraft,
  isAskUserQuestionAnswerComplete,
  isAskUserQuestionRequest,
  parseAskUserQuestionInput,
  updateAskUserQuestionCustomAnswer,
  updateAskUserQuestionSelection
} from "./askUserQuestion"

function request(toolName: string): PermissionRequestPayload {
  return {
    type: "control_request",
    request_id: "r1",
    session_id: "s1",
    request: {
      tool_name: toolName,
      input: {}
    }
  }
}

describe("askUserQuestion", () => {
  it("detects official AskUserQuestion permission requests", () => {
    expect(isAskUserQuestionRequest(request("AskUserQuestion"))).toBe(true)
    expect(isAskUserQuestionRequest(request("Bash"))).toBe(false)
  })

  it("parses the official questions schema", () => {
    const input = parseAskUserQuestionInput({
      questions: [
        {
          question: "UI 更偏向什么风格？",
          header: "UI 风格",
          options: [
            { label: "紧凑", description: "信息密度更高" },
            { label: "宽松", description: "留白更多" }
          ],
          multiSelect: false
        }
      ]
    })

    expect(input.questions[0].options[1].label).toBe("宽松")
    expect(input.questions[0].multiSelect).toBe(false)
  })

  it("accepts options without descriptions", () => {
    const input = parseAskUserQuestionInput({
      questions: [
        {
          question: "需要改到哪一层？",
          header: "范围",
          options: [
            { label: "仅设计系统层 (tokens + globals.css)" },
            { label: "完整组件层", description: "包含组件实现" }
          ],
          multiSelect: false
        }
      ]
    })

    expect(input.questions[0].options[0]).toEqual({
      label: "仅设计系统层 (tokens + globals.css)"
    })
  })

  it("returns answers in the format Claude expects", () => {
    const input = parseAskUserQuestionInput({
      questions: [
        {
          question: "包含哪些页面？",
          header: "页面",
          options: [
            { label: "首页", description: "包含概览" },
            { label: "设置", description: "包含配置" }
          ],
          multiSelect: true
        }
      ]
    })

    expect(
      buildAskUserQuestionResponse(input, {
        "包含哪些页面？": ["首页", "设置"]
      })
    ).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: input.questions,
        answers: {
          "包含哪些页面？": ["首页", "设置"]
        }
      }
    })
  })

  it("rejects malformed question payloads explicitly", () => {
    expect(() => parseAskUserQuestionInput({ questions: [] })).toThrow(
      "AskUserQuestion 必须包含 1 到 4 个问题"
    )
  })

  it("rejects non-string option descriptions explicitly", () => {
    expect(() =>
      parseAskUserQuestionInput({
        questions: [
          {
            question: "需要改到哪一层？",
            header: "范围",
            options: [
              { label: "仅设计系统层", description: 1 },
              { label: "完整组件层" }
            ],
            multiSelect: false
          }
        ]
      })
    ).toThrow("选项「仅设计系统层」的 description 必须是字符串")
  })

  it("toggles a selected single-select option off", () => {
    const input = parseAskUserQuestionInput({
      questions: [
        {
          question: "选择框架？",
          header: "框架",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: false
        }
      ]
    })

    const selected = updateAskUserQuestionSelection(
      initialAskUserQuestionDraft(input),
      0,
      "React",
      false
    )
    const cleared = updateAskUserQuestionSelection(selected, 0, "React", false)

    expect(selected[0]).toEqual({ selected: ["React"], custom: "" })
    expect(cleared[0]).toEqual({ selected: [], custom: "" })
    expect(collectAskUserQuestionAnswers(input, cleared)).toBeNull()
  })

  it("uses custom text as the single-select answer and clears the selected option", () => {
    const input = parseAskUserQuestionInput({
      questions: [
        {
          question: "选择框架？",
          header: "框架",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: false
        }
      ]
    })
    const selected = updateAskUserQuestionSelection(
      initialAskUserQuestionDraft(input),
      0,
      "React",
      false
    )
    const custom = updateAskUserQuestionCustomAnswer(
      selected,
      0,
      "Svelte",
      false
    )

    expect(custom[0]).toEqual({ selected: [], custom: "Svelte" })
    expect(collectAskUserQuestionAnswers(input, custom)).toEqual({
      "选择框架？": "Svelte"
    })
  })

  it("keeps single-select custom text as a draft but submits the selected option", () => {
    const input = parseAskUserQuestionInput({
      questions: [
        {
          question: "选择框架？",
          header: "框架",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: false
        }
      ]
    })
    const custom = updateAskUserQuestionCustomAnswer(
      initialAskUserQuestionDraft(input),
      0,
      "Svelte",
      false
    )
    const selected = updateAskUserQuestionSelection(custom, 0, "Vue", false)

    expect(selected[0]).toEqual({ selected: ["Vue"], custom: "Svelte" })
    expect(collectAskUserQuestionAnswers(input, selected)).toEqual({
      "选择框架？": "Vue"
    })
  })

  it("falls back to preserved custom text after clearing a single-select option", () => {
    const input = parseAskUserQuestionInput({
      questions: [
        {
          question: "选择框架？",
          header: "框架",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: false
        }
      ]
    })
    const custom = updateAskUserQuestionCustomAnswer(
      initialAskUserQuestionDraft(input),
      0,
      "Svelte",
      false
    )
    const selected = updateAskUserQuestionSelection(custom, 0, "Vue", false)
    const cleared = updateAskUserQuestionSelection(selected, 0, "Vue", false)

    expect(cleared[0]).toEqual({ selected: [], custom: "Svelte" })
    expect(collectAskUserQuestionAnswers(input, cleared)).toEqual({
      "选择框架？": "Svelte"
    })
  })

  it("tracks per-question completeness for page indicators", () => {
    const input = parseAskUserQuestionInput({
      questions: [
        {
          question: "选择框架？",
          header: "框架",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: false
        },
        {
          question: "包含哪些部分？",
          header: "范围",
          options: [{ label: "测试" }, { label: "文档" }],
          multiSelect: true
        }
      ]
    })

    const empty = initialAskUserQuestionDraft(input)
    expect(isAskUserQuestionAnswerComplete(input.questions[0], empty[0])).toBe(
      false
    )
    expect(isAskUserQuestionAnswerComplete(input.questions[0], undefined)).toBe(
      false
    )

    const withSelection = updateAskUserQuestionSelection(empty, 0, "React", false)
    expect(
      isAskUserQuestionAnswerComplete(input.questions[0], withSelection[0])
    ).toBe(true)

    const withCustom = updateAskUserQuestionCustomAnswer(empty, 1, "示例", true)
    expect(
      isAskUserQuestionAnswerComplete(input.questions[1], withCustom[1])
    ).toBe(true)
  })

  it("keeps multi-select options additive with custom text", () => {
    const input = parseAskUserQuestionInput({
      questions: [
        {
          question: "包含哪些部分？",
          header: "范围",
          options: [{ label: "测试" }, { label: "文档" }],
          multiSelect: true
        }
      ]
    })
    const selected = updateAskUserQuestionSelection(
      initialAskUserQuestionDraft(input),
      0,
      "测试",
      true
    )
    const custom = updateAskUserQuestionCustomAnswer(selected, 0, "示例", true)

    expect(custom[0]).toEqual({ selected: ["测试"], custom: "示例" })
    expect(collectAskUserQuestionAnswers(input, custom)).toEqual({
      "包含哪些部分？": ["测试", "示例"]
    })
  })
})
