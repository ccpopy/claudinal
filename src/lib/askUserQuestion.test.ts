import { describe, expect, it } from "vitest"
import type { PermissionRequestPayload } from "./ipc"
import {
  buildAskUserQuestionResponse,
  isAskUserQuestionRequest,
  parseAskUserQuestionInput
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
})
