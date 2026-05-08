import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PermissionRequestPayload } from "./ipc"
import {
  canRememberExactPermission,
  findPermissionMemoryMatch,
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
})
