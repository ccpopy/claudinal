import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PermissionRequestPayload } from "./ipc"
import {
  canRememberCategoryPermission,
  canRememberExactPermission,
  classifyPermissionRequestCategory,
  findPermissionMemoryMatch,
  rememberCategoryPermissionRequest,
  rememberExactPermissionRequest
} from "./permissionMemory"

class MemoryStorage {
  private data = new Map<string, string>()

  getItem(key: string) {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.data.set(key, value)
  }

  clear() {
    this.data.clear()
  }
}

function request(command: string, cwd = "F:\\project\\demo"): PermissionRequestPayload {
  return {
    type: "control_request",
    request_id: "r1",
    session_id: "s1",
    cwd,
    request: {
      tool_name: "Bash",
      input: { command }
    }
  }
}

describe("permissionMemory", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage())
  })

  it("remembers and matches exact commands in the same cwd", () => {
    const payload = request("pnpm build")
    expect(canRememberExactPermission(payload)).toBe(true)
    rememberExactPermissionRequest(payload)
    expect(findPermissionMemoryMatch(request("pnpm build"))?.toolName).toBe("bash")
    expect(findPermissionMemoryMatch(request("pnpm test"))).toBeNull()
    expect(findPermissionMemoryMatch(request("pnpm build", "F:\\project\\other"))).toBeNull()
  })

  it("does not offer exact memory when an allow rule suggestion exists", () => {
    const payload = request("pnpm build")
    payload.request.permission_suggestions = [
      {
        type: "addRules",
        behavior: "allow",
        rules: [{ ruleContent: "Bash(pnpm build)" }]
      }
    ]
    expect(canRememberExactPermission(payload)).toBe(false)
  })

  it("does not offer exact memory when any permission suggestion exists", () => {
    const payload = request("pnpm build")
    payload.request.permission_suggestions = [
      {
        type: "setMode",
        mode: "acceptEdits"
      }
    ]
    expect(canRememberExactPermission(payload)).toBe(false)
  })

  it("remembers project check command categories in the same cwd", () => {
    const payload = request("pnpm build")
    expect(classifyPermissionRequestCategory(payload)?.id).toBe(
      "bash:project-checks"
    )
    expect(canRememberCategoryPermission(payload)).toBe(true)
    rememberCategoryPermissionRequest(payload)

    expect(findPermissionMemoryMatch(request("pnpm test"))?.kind).toBe(
      "category"
    )
    expect(findPermissionMemoryMatch(request("pnpm run test"))?.kind).toBe(
      "category"
    )
    expect(findPermissionMemoryMatch(request("cargo check"))?.kind).toBe(
      "category"
    )
    expect(
      findPermissionMemoryMatch(request("pnpm test", "F:\\project\\other"))
    ).toBeNull()
  })

  it("does not offer category memory when Claude provides an allow rule", () => {
    const payload = request("pnpm build")
    payload.request.permission_suggestions = [
      {
        type: "addRules",
        behavior: "allow",
        rules: [{ ruleContent: "Bash(pnpm build)" }]
      }
    ]

    expect(canRememberCategoryPermission(payload)).toBe(false)
  })

  it("offers category memory for MCP requests because Claude project rules cannot be updated", () => {
    const payload = request("pnpm build")
    payload.transport = "mcp"
    payload.request.permission_suggestions = [
      {
        type: "addRules",
        behavior: "allow",
        rules: [{ ruleContent: "Bash(pnpm build)" }]
      }
    ]

    expect(canRememberCategoryPermission(payload)).toBe(true)
  })

  it("does not categorize chained or destructive-looking commands", () => {
    expect(
      classifyPermissionRequestCategory(request("pnpm test && rm -rf dist"))
    ).toBeNull()
    expect(
      classifyPermissionRequestCategory(request("git branch -D stale"))
    ).toBeNull()
    expect(
      classifyPermissionRequestCategory(request("git remote add origin repo"))
    ).toBeNull()
    expect(
      classifyPermissionRequestCategory(request("git diff --output=patch.txt"))
    ).toBeNull()
    expect(
      classifyPermissionRequestCategory(request("find . -delete"))
    ).toBeNull()
    expect(
      classifyPermissionRequestCategory(request("find . -exec rm {} ;"))
    ).toBeNull()
  })

  it("categorizes read-only git and file inspection commands", () => {
    expect(classifyPermissionRequestCategory(request("git status"))?.id).toBe(
      "bash:git-read"
    )
    expect(classifyPermissionRequestCategory(request("git remote -v"))?.id).toBe(
      "bash:git-read"
    )
    expect(
      classifyPermissionRequestCategory(request("git remote show origin"))?.id
    ).toBe("bash:git-read")
    expect(classifyPermissionRequestCategory(request("rg Permission"))?.id).toBe(
      "bash:file-read"
    )
  })
})
