import { describe, expect, it } from "vitest"
import { detectNetworkError } from "./networkErrorHints"

describe("networkErrorHints.detectNetworkError", () => {
  it("returns null for null/undefined/empty", () => {
    expect(detectNetworkError(null)).toBeNull()
    expect(detectNetworkError(undefined)).toBeNull()
    expect(detectNetworkError("")).toBeNull()
    expect(detectNetworkError("   ")).toBeNull()
  })

  it("does not flag normal stderr lines without network keywords", () => {
    expect(detectNetworkError("Loading model preferences from settings.json")).toBeNull()
    expect(detectNetworkError("[debug] message_start id=msg_01")).toBeNull()
  })

  it("identifies proxy errors", () => {
    const direct = detectNetworkError(
      "error: Failed to connect to api.anthropic.com via proxy 127.0.0.1:7890"
    )
    expect(direct?.topic).toBe("proxy")
    const refused = detectNetworkError("error: proxy connect: connection refused")
    expect(refused?.topic).toBe("proxy")
    const badGateway = detectNetworkError("HTTP/1.1 502 Bad Gateway received from proxy")
    expect(badGateway?.topic).toBe("proxy")
  })

  it("identifies TLS / certificate errors", () => {
    expect(detectNetworkError("TLS handshake failed: invalid certificate")?.topic).toBe(
      "tls"
    )
    expect(detectNetworkError("x509: certificate signed by unknown authority")?.topic).toBe(
      "tls"
    )
    expect(detectNetworkError("unable to get local issuer certificate")?.topic).toBe(
      "tls"
    )
  })

  it("identifies DNS resolution errors", () => {
    expect(detectNetworkError("could not resolve host: api.anthropic.com")?.topic).toBe(
      "dns"
    )
    expect(detectNetworkError("getaddrinfo ENOTFOUND api.anthropic.com")?.topic).toBe(
      "dns"
    )
  })

  it("identifies timeouts", () => {
    expect(detectNetworkError("Operation timed out after 30000ms")?.topic).toBe(
      "timeout"
    )
    expect(detectNetworkError("connect ETIMEDOUT 1.2.3.4:443")?.topic).toBe(
      "timeout"
    )
  })

  it("identifies connection refused / reset", () => {
    expect(detectNetworkError("connect ECONNREFUSED 127.0.0.1:7890")?.topic).toBe(
      "refused"
    )
    expect(
      detectNetworkError("read ECONNRESET while waiting for response")?.topic
    ).toBe("refused")
    expect(detectNetworkError("Network is unreachable")?.topic).toBe("refused")
  })

  it("identifies rate limit hits", () => {
    expect(detectNetworkError("HTTP status 429 Too Many Requests")?.topic).toBe(
      "rate-limit"
    )
    expect(detectNetworkError("Rate limit reached for opus")?.topic).toBe(
      "rate-limit"
    )
  })

  it("identifies auth failures", () => {
    expect(detectNetworkError("HTTP Status 401 Unauthorized")?.topic).toBe(
      "auth"
    )
    expect(
      detectNetworkError("403 Forbidden: invalid API key")?.topic
    ).toBe("auth")
    // 含 "Invalid API Key" 也应识别
    expect(detectNetworkError("Authentication failed: Invalid API Key")?.topic)
      .toBe("auth")
  })

  it("identifies 5xx server errors", () => {
    expect(detectNetworkError("HTTP status 503 Service Unavailable")?.topic).toBe(
      "server-5xx"
    )
    expect(detectNetworkError("502 Bad Gateway")?.topic).toBe("server-5xx")
  })

  it("prefers proxy classification when proxy keyword is followed by an error verb", () => {
    // proxy keyword 模式要求 proxy 之后跟 error/connect/fail 等动词；
    // 只是 "via proxy <ip>: operation timed out" 实际属于超时场景，因此命中 timeout 更准确。
    const hit = detectNetworkError(
      "Failed to connect via proxy 127.0.0.1: operation timed out"
    )
    expect(hit?.topic).toBe("timeout")

    // 而 proxy connect failed / proxy authentication 之类场景才会归为 proxy
    expect(detectNetworkError("proxy connect failed")?.topic).toBe("proxy")
  })

  it("provides non-empty summary and hint for matched topics", () => {
    const hit = detectNetworkError("connect ECONNREFUSED")
    expect(hit?.summary).toBeTruthy()
    expect(hit?.hint && hit.hint.length).toBeGreaterThan(0)
  })
})
