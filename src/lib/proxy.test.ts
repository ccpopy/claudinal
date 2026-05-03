import { describe, expect, it } from "vitest"
import {
  buildProxyEnv,
  describeProxy,
  formatProxyUrl,
  type ProxyConfig
} from "./proxy"

const base: ProxyConfig = {
  enabled: true,
  protocol: "http",
  host: "10.0.0.1",
  port: "8080",
  username: "",
  password: "",
  noProxy: ""
}

describe("proxy.formatProxyUrl", () => {
  it("returns plain URL when no auth is configured", () => {
    expect(formatProxyUrl({ ...base })).toBe("http://10.0.0.1:8080")
  })

  it("encodes username when password is empty", () => {
    expect(
      formatProxyUrl({ ...base, username: "user@corp", password: "" })
    ).toBe("http://user%40corp@10.0.0.1:8080")
  })

  it("encodes special characters in username and password", () => {
    expect(
      formatProxyUrl({
        ...base,
        username: "user name",
        password: "p@ss:word/?"
      })
    ).toBe("http://user%20name:p%40ss%3Aword%2F%3F@10.0.0.1:8080")
  })

  it("respects the configured protocol", () => {
    expect(
      formatProxyUrl({
        ...base,
        protocol: "socks5h",
        host: "proxy.local",
        port: "1080"
      })
    ).toBe("socks5h://proxy.local:1080")
  })
})

describe("proxy.buildProxyEnv", () => {
  it("returns an empty object when proxy is disabled or incomplete", () => {
    expect(buildProxyEnv(null)).toEqual({})
    expect(buildProxyEnv({ ...base, enabled: false })).toEqual({})
    expect(buildProxyEnv({ ...base, host: "" })).toEqual({})
    expect(buildProxyEnv({ ...base, port: "" })).toEqual({})
  })

  it("emits both lower and upper case variants for HTTP_PROXY/NO_PROXY", () => {
    const env = buildProxyEnv({ ...base })
    expect(env.HTTP_PROXY).toBe("http://10.0.0.1:8080")
    expect(env.HTTPS_PROXY).toBe("http://10.0.0.1:8080")
    expect(env.ALL_PROXY).toBe("http://10.0.0.1:8080")
    expect(env.http_proxy).toBe(env.HTTP_PROXY)
    expect(env.https_proxy).toBe(env.HTTPS_PROXY)
    expect(env.all_proxy).toBe(env.ALL_PROXY)
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1")
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })

  it("preserves user-provided NO_PROXY without injecting the default loopbacks", () => {
    const env = buildProxyEnv({
      ...base,
      noProxy: "intranet.local,*.corp"
    })
    expect(env.NO_PROXY).toBe("intranet.local,*.corp")
    expect(env.no_proxy).toBe("intranet.local,*.corp")
  })
})

describe("proxy.describeProxy", () => {
  it("describes disabled proxy", () => {
    expect(describeProxy({ ...base, enabled: false })).toBe("未启用")
  })

  it("warns when host or port is missing while enabled", () => {
    expect(describeProxy({ ...base, host: "" })).toBe("未配置")
    expect(describeProxy({ ...base, port: "" })).toBe("未配置")
  })

  it("returns protocol://host:port when fully configured", () => {
    expect(describeProxy({ ...base })).toBe("http://10.0.0.1:8080")
    expect(
      describeProxy({ ...base, protocol: "socks5", host: "p", port: "9" })
    ).toBe("socks5://p:9")
  })
})
