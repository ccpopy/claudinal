import { describe, expect, it } from "vitest"
import type { PermissionRequestPayload } from "./ipc"
import {
  autoApprovePermissionRequest,
  classifyBashPermissionRisk
} from "./permissionPolicy"
import type { AppSettings } from "./settings"

function request(
  toolName: string,
  input: Record<string, unknown> = {}
): PermissionRequestPayload {
  return {
    type: "control_request",
    request_id: "r1",
    session_id: "s1",
    cwd: "F:\\project\\demo",
    request: {
      tool_name: toolName,
      input
    }
  }
}

function bash(command: string): PermissionRequestPayload {
  return request("Bash", { command })
}

function approved(
  payload: PermissionRequestPayload,
  mode: AppSettings["defaultPermissionMode"]
): boolean {
  return autoApprovePermissionRequest(payload, mode) !== null
}

describe("permissionPolicy", () => {
  it("never auto-approves AskUserQuestion because it is a user decision", () => {
    expect(approved(request("AskUserQuestion"), "default")).toBe(false)
    expect(approved(request("AskUserQuestion"), "acceptEdits")).toBe(false)
    expect(approved(request("AskUserQuestion"), "bypassPermissions")).toBe(false)
  })

  it("does not auto-approve external MCP or plugin tools", () => {
    expect(approved(request("mcp__github__create_issue"), "bypassPermissions")).toBe(
      false
    )
  })

  it("auto-approves built-in read-only tools in normal modes", () => {
    expect(approved(request("Read", { file_path: "README.md" }), "default")).toBe(
      true
    )
    expect(approved(request("LS", { path: "." }), "acceptEdits")).toBe(true)
    expect(approved(request("Grep", { pattern: "permission" }), "plan")).toBe(
      true
    )
  })

  it("keeps edit tools visible in default mode and skips them in acceptEdits", () => {
    expect(approved(request("Edit", { file_path: "src/App.tsx" }), "default")).toBe(
      false
    )
    expect(
      approved(request("MultiEdit", { file_path: "src/App.tsx" }), "acceptEdits")
    ).toBe(true)
  })

  it("auto-approves ordinary bash commands but prompts for deletion and cleanup", () => {
    expect(approved(bash("git commit -m fix"), "default")).toBe(true)
    expect(approved(bash("pnpm build"), "default")).toBe(true)
    expect(approved(bash("rm -rf dist"), "default")).toBe(false)
    expect(approved(bash("git clean -fd"), "default")).toBe(false)
    expect(approved(bash("cargo clean"), "default")).toBe(false)
    expect(approved(bash("find . -delete"), "default")).toBe(false)
  })

  it("treats shell file writes as edit requests", () => {
    expect(classifyBashPermissionRisk("echo hi > README.md")).toBe("file-edit")
    expect(classifyBashPermissionRisk("sed -i s/a/b/ README.md")).toBe(
      "file-edit"
    )
    expect(approved(bash("echo hi > README.md"), "default")).toBe(false)
    expect(approved(bash("echo hi > README.md"), "acceptEdits")).toBe(true)
  })

  it("keeps plan mode limited to read-only shell commands", () => {
    expect(approved(bash("git status"), "plan")).toBe(true)
    expect(approved(bash("git commit -m fix"), "plan")).toBe(false)
  })

  it("bypassPermissions skips built-in tool permissions except user decisions", () => {
    expect(approved(request("Write", { file_path: "a.txt" }), "bypassPermissions")).toBe(
      true
    )
    expect(approved(bash("rm -rf dist"), "bypassPermissions")).toBe(true)
  })
})
