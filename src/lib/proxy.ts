export type ProxyProtocol = "http" | "https" | "socks5" | "socks5h"

export interface ProxyConfig {
  enabled: boolean
  protocol: ProxyProtocol
  host: string
  port: string
  username: string
  password: string
  noProxy: string
}

export const DEFAULT_PROXY: ProxyConfig = {
  enabled: false,
  protocol: "http",
  host: "",
  port: "",
  username: "",
  password: "",
  noProxy: "localhost,127.0.0.1,::1"
}

const KEY = "claudecli.proxy"

export function loadProxy(): ProxyConfig {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_PROXY }
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_PROXY, ...parsed }
  } catch {
    return { ...DEFAULT_PROXY }
  }
}

export function saveProxy(c: ProxyConfig) {
  localStorage.setItem(KEY, JSON.stringify(c))
}

export function formatProxyUrl(c: ProxyConfig): string {
  const auth = c.username
    ? `${encodeURIComponent(c.username)}${c.password ? `:${encodeURIComponent(c.password)}` : ""}@`
    : ""
  return `${c.protocol}://${auth}${c.host}:${c.port}`
}

export function buildProxyEnv(c: ProxyConfig | null): Record<string, string> {
  if (!c || !c.enabled || !c.host || !c.port) return {}
  const url = formatProxyUrl(c)
  // noProxy 留空时带默认 localhost,127.0.0.1,::1，避免本机回环服务被代理拦截
  const noProxy = (c.noProxy || "").trim() || DEFAULT_PROXY.noProxy
  const env: Record<string, string> = {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy
  }
  return env
}

export function describeProxy(c: ProxyConfig): string {
  if (!c.enabled) return "未启用"
  if (!c.host || !c.port) return "未配置"
  return `${c.protocol}://${c.host}:${c.port}`
}
