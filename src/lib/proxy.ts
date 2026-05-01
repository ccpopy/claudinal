import {
  keychainAvailable,
  keychainDelete,
  keychainGet,
  keychainSet
} from "@/lib/ipc"
import { emitSettingsBus } from "@/lib/settingsBus"

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
// keychain 条目 account；service 在 Rust 侧固定为 "claudinal"
const KEYCHAIN_ACCOUNT = "proxy.password"

interface PersistedShape {
  enabled?: boolean
  protocol?: ProxyProtocol
  host?: string
  port?: string
  username?: string
  /** 旧版（< 2026-05-01）会把明文密码写在这里；新版迁移完后此字段不再写 */
  password?: string
  /** 标记 password 字段是否仍是 legacy 明文，需要迁移到 keychain */
  legacyPassword?: boolean
  noProxy?: string
}

function readPersisted(): PersistedShape {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PersistedShape
    }
    return {}
  } catch {
    return {}
  }
}

function writePersisted(shape: PersistedShape) {
  localStorage.setItem(KEY, JSON.stringify(shape))
  emitSettingsBus("proxy")
}

/**
 * 同步读取（不含密码）。spawn 之外的纯展示场景可以用这条；
 * 真正要拿密码拼代理 URL 必须走 `loadProxyAsync()`。
 */
export function loadProxy(): ProxyConfig {
  const p = readPersisted()
  return {
    ...DEFAULT_PROXY,
    ...p,
    // 同步路径不暴露 password；keychain 读必须 async
    password: ""
  }
}

/**
 * 异步读取，密码优先来自 keychain；keychain 不可用 / 没条目时回退 localStorage 明文（兼容旧版）。
 */
export async function loadProxyAsync(): Promise<ProxyConfig> {
  const persisted = readPersisted()
  const base: ProxyConfig = { ...DEFAULT_PROXY, ...persisted, password: "" }
  let pwd = ""
  let kcOk = false
  try {
    kcOk = await keychainAvailable()
  } catch {
    kcOk = false
  }
  if (kcOk) {
    try {
      pwd = (await keychainGet(KEYCHAIN_ACCOUNT)) ?? ""
    } catch {
      pwd = ""
    }
  }
  if (!pwd && persisted.password) {
    // legacy localStorage 明文回退；下一次 saveProxyAsync 会把它迁移到 keychain
    pwd = persisted.password
  }
  return { ...base, password: pwd }
}

/**
 * 写入：保存非敏感字段到 localStorage，把密码送进 keychain。
 * - keychain 不可用时，密码写回 localStorage 并打 `legacyPassword=true` 标记，UI 显示警告。
 * - 写 keychain 成功时，确保 localStorage 中遗留的 `password` 字段被清除（迁移完成）。
 *
 * 返回值：`stored` 表示密码实际落到哪里。
 */
export async function saveProxyAsync(
  c: ProxyConfig
): Promise<"keychain" | "localstorage" | "empty"> {
  const { password, ...rest } = c
  const pwd = password ?? ""
  const shape: PersistedShape = { ...rest }
  let stored: "keychain" | "localstorage" | "empty" = "empty"

  let kcOk = false
  try {
    kcOk = await keychainAvailable()
  } catch {
    kcOk = false
  }

  if (kcOk) {
    try {
      if (pwd) {
        await keychainSet(KEYCHAIN_ACCOUNT, pwd)
        stored = "keychain"
      } else {
        await keychainDelete(KEYCHAIN_ACCOUNT)
      }
    } catch {
      // keychain 突然抽风：降级到 localStorage 明文
      kcOk = false
    }
  }

  if (!kcOk && pwd) {
    shape.password = pwd
    shape.legacyPassword = true
    stored = "localstorage"
  } else {
    delete shape.password
    delete shape.legacyPassword
  }

  writePersisted(shape)
  return stored
}

/**
 * 同步保存（仅元信息，不含密码）。仅给特定场景（如 enabled toggle 即时落地）使用。
 * 大部分场景应该用 `saveProxyAsync`，让密码同步进 keychain。
 */
export function saveProxy(c: ProxyConfig) {
  // 兼容旧调用方：仅写非敏感部分到 localStorage，密码不动
  const cur = readPersisted()
  const { password: _drop, ...rest } = c
  void _drop
  writePersisted({ ...cur, ...rest })
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

/**
 * 启动时尝试一次性迁移：如果 localStorage 里 `password` 字段存在 + keychain 可用，
 * 就把它写进 keychain 并从 localStorage 删掉。失败静默，下次 save 时还会尝试。
 */
export async function migrateLegacyProxyPassword(): Promise<void> {
  const persisted = readPersisted()
  if (!persisted.password) return
  let kcOk = false
  try {
    kcOk = await keychainAvailable()
  } catch {
    kcOk = false
  }
  if (!kcOk) return
  try {
    await keychainSet(KEYCHAIN_ACCOUNT, persisted.password)
    delete persisted.password
    delete persisted.legacyPassword
    writePersisted(persisted)
  } catch {
    // 静默
  }
}
