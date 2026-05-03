import { useCallback, useEffect, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Stethoscope,
  XCircle
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  detectPlaywrightInstall,
  openPath,
  readClaudeJsonMcpConfigs,
  readClaudeMcpConfig,
  readClaudeSettings,
  writeClaudeMcpConfig,
  type PlaywrightInstallState
} from "@/lib/ipc"
import {
  loadMcpStatusCache,
  normalizeMcpConfig,
  type McpServerConfig
} from "@/lib/mcp"
import {
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionHeader
} from "./layout"

// 字符匹配判定「这个 MCP server 是不是浏览器类」。covers playwright / chrome-devtools-mcp /
// puppeteer-mcp / browser-use 等社区命名习惯。匹配 server name + command + args。
const BROWSER_KEYWORDS = [
  "playwright",
  "browser",
  "chromium",
  "chrome",
  "puppeteer",
  "webkit"
]

const PLAYWRIGHT_DEFAULT_NAME = "playwright"
const PLAYWRIGHT_DEFAULT_CONFIG: McpServerConfig = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@playwright/mcp"]
}
const INSTALL_HINT = "npx playwright install chromium"

interface BrowserMcpRow {
  name: string
  scope: "global" | "project"
  config: McpServerConfig
  status: string | null
}

interface PlaywrightEnvEntry {
  key: string
  value: string
}

// 用户在 ~/.claude/settings.json 的 env 里手动设置这些时，可能直接影响
// Playwright 启动行为；列出来让用户对照排查。
const PLAYWRIGHT_ENV_KEYS = [
  "PLAYWRIGHT_BROWSERS_PATH",
  "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
  "PLAYWRIGHT_LAUNCH_OPTIONS",
  "PLAYWRIGHT_HEADLESS",
  "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
  "PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH",
  "PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH"
]

function isFailingStatus(status: string | null): boolean {
  return status === "failed" || status === "error"
}

function isBrowserServer(name: string, config: McpServerConfig): boolean {
  const haystack = [name, config.command ?? "", ...(config.args ?? [])]
    .join(" ")
    .toLowerCase()
  return BROWSER_KEYWORDS.some((k) => haystack.includes(k))
}

interface Props {
  cwd?: string | null
}

export function Browser({ cwd }: Props) {
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rows, setRows] = useState<BrowserMcpRow[]>([])
  const [pw, setPw] = useState<PlaywrightInstallState | null>(null)
  const [envEntries, setEnvEntries] = useState<PlaywrightEnvEntry[]>([])
  const enabledBrowserMcpCount = rows.filter(
    (row) => row.config.disabled !== true
  ).length
  const failingRows = rows.filter((row) => isFailingStatus(row.status))
  const hasChromium = !!pw?.chromium
  const browserReady = enabledBrowserMcpCount > 0 && hasChromium

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const statuses = loadMcpStatusCache()
      const statusMap = new Map(statuses.map((s) => [s.name, s.status]))
      const out: BrowserMcpRow[] = []
      const seen = new Set<string>()
      const push = (
        name: string,
        scope: "global" | "project",
        conf: McpServerConfig
      ) => {
        if (!isBrowserServer(name, conf)) return
        const key = `${scope}:${name}`
        if (seen.has(key)) return
        seen.add(key)
        out.push({
          name,
          scope,
          config: conf,
          status: statusMap.get(name) ?? null
        })
      }
      const collectMcpJson = async (scope: "global" | "project") => {
        if (scope === "project" && !cwd) return
        try {
          const raw = await readClaudeMcpConfig(scope, cwd ?? undefined)
          const cfg = normalizeMcpConfig(raw)
          for (const [name, conf] of Object.entries(cfg.mcpServers ?? {})) {
            push(name, scope, conf)
          }
        } catch {
          // 文件缺失或损坏视作空
        }
      }
      await collectMcpJson("global")
      await collectMcpJson("project")

      // ~/.claude.json（CLI 全局/项目）也是 server 来源 —— McpServers 页同样读这两份。
      try {
        const cj = await readClaudeJsonMcpConfigs(cwd ?? undefined)
        const ingest = (
          raw: Record<string, unknown> | null,
          scope: "global" | "project"
        ) => {
          if (!raw) return
          const cfg = normalizeMcpConfig(raw)
          for (const [name, conf] of Object.entries(cfg.mcpServers ?? {})) {
            push(name, scope, conf)
          }
        }
        ingest(cj.global, "global")
        if (cwd) ingest(cj.project, "project")
      } catch {
        // ignore
      }

      setRows(out)

      try {
        setPw(await detectPlaywrightInstall())
      } catch {
        setPw(null)
      }

      try {
        const s = await readClaudeSettings("global")
        const env = ((s as { env?: Record<string, string> } | null)?.env) ?? {}
        const entries: PlaywrightEnvEntry[] = []
        for (const key of PLAYWRIGHT_ENV_KEYS) {
          const value = env[key]
          if (typeof value === "string" && value.trim()) {
            entries.push({ key, value })
          }
        }
        setEnvEntries(entries)
      } catch {
        setEnvEntries([])
      }
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    refresh()
  }, [refresh])

  const installPlaywright = useCallback(async () => {
    setBusy(true)
    try {
      const raw = (await readClaudeMcpConfig("global")) ?? {}
      const cfg = normalizeMcpConfig(raw)
      const next = {
        ...cfg,
        mcpServers: {
          ...cfg.mcpServers,
          [PLAYWRIGHT_DEFAULT_NAME]: PLAYWRIGHT_DEFAULT_CONFIG
        }
      }
      await writeClaudeMcpConfig("global", next as Record<string, unknown>)
      toast.success("已添加 playwright 到 ~/.claude/mcp.json，下次启动会话生效")
      refresh()
    } catch (e) {
      toast.error(`添加失败: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const copyInstallCmd = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_HINT)
      toast.success("已复制安装命令")
    } catch (e) {
      toast.error(`复制失败: ${String(e)}`)
    }
  }

  return (
    <SettingsSection>
      <SettingsSectionHeader
        icon={Globe}
        title="浏览器使用"
        actions={
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
          刷新
        </Button>
        }
      />

      <SettingsSectionBody>
          <section className="rounded-lg border bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">Claude 浏览器可用性</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Claude CLI 需要加载浏览器 MCP 并找到 Playwright 浏览器才能操控浏览器。
                </p>
              </div>
              <Badge variant={browserReady ? "primary" : "warn"} className="font-sans">
                {browserReady
                  ? "已就绪"
                  : enabledBrowserMcpCount === 0
                    ? "缺少浏览器 MCP"
                    : "缺少 Chromium"}
              </Badge>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <ReadinessItem
                label="浏览器 MCP"
                ok={enabledBrowserMcpCount > 0}
                value={
                  enabledBrowserMcpCount > 0
                    ? `${enabledBrowserMcpCount} 个已启用`
                    : "未检测到"
                }
              />
              <ReadinessItem
                label="Playwright Chromium"
                ok={hasChromium}
                value={hasChromium ? "已安装" : "未安装"}
              />
            </div>
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold">浏览器 MCP</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                读取的是 MCP 服务器页的同一份配置。通过 MCP 让 Claude 操控浏览器；配置文件为{" "}
                <code className="font-mono">~/.claude/mcp.json</code> 或{" "}
                <code className="font-mono">&lt;cwd&gt;/.mcp.json</code>，由 CLI 加载。
              </p>
            </div>

            {rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-card py-10">
                {loading ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <>
                    <Globe className="size-6 text-muted-foreground" />
                    <div className="mt-2 text-sm font-medium">未找到浏览器 MCP</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      没有名字或命令含 playwright / chromium / browser 的 server。
                    </div>
                    <Button
                      size="sm"
                      className="mt-3"
                      onClick={installPlaywright}
                      disabled={busy}
                    >
                      {busy ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Plus className="size-3.5" />
                      )}
                      一键添加 playwright（用户级）
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border bg-card">
                {rows.map((row) => (
                  <ServerRow key={`${row.scope}:${row.name}`} row={row} />
                ))}
                <div className="border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
                  已检测到浏览器 MCP。修改、停用或删除请到 MCP 服务器页处理，此页只做浏览器能力诊断，避免重复添加同类 server。
                </div>
              </div>
            )}
          </section>

          {(failingRows.length > 0 || envEntries.length > 0) && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Stethoscope className="size-4 text-warn" />
                <h3 className="text-sm font-semibold">MCP 启动诊断</h3>
                <Badge variant="warn" className="font-sans text-[10px]">
                  {failingRows.length > 0 ? "检测到失败" : "环境变量提醒"}
                </Badge>
              </div>

              {failingRows.length > 0 && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-3 text-xs">
                  <div className="flex items-start gap-2">
                    <XCircle className="size-4 shrink-0 text-destructive mt-0.5" />
                    <div className="min-w-0 space-y-1.5">
                      <div className="font-medium text-destructive">
                        以下浏览器 MCP 启动失败：
                      </div>
                      <ul className="ml-1 space-y-0.5">
                        {failingRows.map((row) => (
                          <li
                            key={`${row.scope}:${row.name}`}
                            className="font-mono break-all"
                          >
                            · {row.name}
                            <span className="ml-1 text-[11px] text-muted-foreground">
                              （{row.scope === "global" ? "用户级" : "项目级"} · {row.status}）
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <div className="space-y-1.5 text-muted-foreground">
                    <div className="font-medium text-foreground">常见原因 & 排查：</div>
                    <ol className="ml-4 list-decimal space-y-1">
                      <li>
                        <strong className="text-foreground">npx 不可用</strong>：MCP command 默认是 <code className="font-mono">npx</code>，确认本机已安装 Node.js（推荐 ≥ 18），并且 PATH 中可执行 <code className="font-mono">npx --version</code>。
                      </li>
                      <li>
                        <strong className="text-foreground">Playwright 浏览器缺失</strong>：在终端运行{" "}
                        <code className="font-mono">{INSTALL_HINT}</code>{" "}
                        安装 Chromium。
                      </li>
                      <li>
                        <strong className="text-foreground">网络问题</strong>：首次拉取 <code className="font-mono">@playwright/mcp</code> 需要 npm registry 可达；如果在内网，先到「网络代理」页配置代理或在 settings.json 中设置 <code className="font-mono">npm_config_registry</code>。
                      </li>
                      <li>
                        <strong className="text-foreground">权限被拒</strong>：macOS 首次启动 Chromium 时系统会要求授权；Linux/WSL 缺 GUI 库时需安装 <code className="font-mono">libnss3 libxkbcommon libxcomposite</code> 等。
                      </li>
                      <li>
                        改完配置后回到「MCP 服务器」页重启对应 server，状态会刷新到这里。
                      </li>
                    </ol>
                  </div>
                  <div className="pt-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={refresh}
                      disabled={loading}
                    >
                      <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
                      重新检测
                    </Button>
                  </div>
                </div>
              )}

              {envEntries.length > 0 && (
                <div className="rounded-lg border border-warn/30 bg-warn/5 p-4 space-y-2 text-xs">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="size-4 shrink-0 text-warn mt-0.5" />
                    <div className="min-w-0 space-y-1.5">
                      <div className="font-medium text-foreground">
                        settings.json 中检测到 {envEntries.length} 个 PLAYWRIGHT_* 环境变量
                      </div>
                      <ul className="space-y-0.5 font-mono break-all">
                        {envEntries.map((e) => (
                          <li key={e.key}>
                            "{e.key}": "{e.value}"
                          </li>
                        ))}
                      </ul>
                      <div className="text-muted-foreground">
                        这些值会在 Claude CLI 启动时合并到子进程，可能改变浏览器路径 / 跳过下载 / 强制启动选项。如果与上面的诊断状态不一致，先确认这些字段是有意保留还是历史残留。
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold">Playwright 浏览器</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Playwright 需要本地浏览器才能运行。此处检测{" "}
                <code className="font-mono">ms-playwright</code> 缓存状态，用于排查浏览器是否安装到位。
              </p>
            </div>
            <div className="space-y-3 rounded-lg border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Label className="text-sm">缓存目录</Label>
                  <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {pw?.root_path ?? (loading ? "检测中…" : "未检测")}
                  </div>
                  {pw?.env_override && (
                    <div className="mt-1 text-[11px] text-warn">
                      路径来自环境变量 PLAYWRIGHT_BROWSERS_PATH
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!pw?.root_exists}
                  onClick={() =>
                    pw?.root_path &&
                    openPath(pw.root_path).catch((e) => toast.error(String(e)))
                  }
                >
                  <ExternalLink className="size-3.5" />
                  打开
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <BrowserChip label="Chromium" ok={pw?.chromium} />
                <BrowserChip label="Firefox" ok={pw?.firefox} />
                <BrowserChip label="WebKit" ok={pw?.webkit} />
              </div>
              {pw && !pw.root_exists && (
                <div className="rounded-md border border-warn/30 bg-warn/5 p-3 text-xs">
                  <div className="font-medium text-foreground">
                    尚未安装 Playwright 浏览器
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
                    <span>在终端运行：</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                      {INSTALL_HINT}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2"
                      onClick={copyInstallCmd}
                    >
                      <Copy className="size-3" />
                      复制
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </section>
      </SettingsSectionBody>
    </SettingsSection>
  )
}

function ReadinessItem({
  label,
  value,
  ok
}: {
  label: string
  value: string
  ok: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{value}</div>
      </div>
      {ok ? (
        <CheckCircle2 className="size-4 text-primary" />
      ) : (
        <Circle className="size-4 text-muted-foreground" />
      )}
    </div>
  )
}

function ServerRow({ row }: { row: BrowserMcpRow }) {
  const summary = (() => {
    const t = row.config.type ?? (row.config.url ? "http" : "stdio")
    if (t === "http") return row.config.url ?? "—"
    const command = row.config.command ?? ""
    const args = (row.config.args ?? []).join(" ")
    return `${command} ${args}`.trim() || "—"
  })()
  return (
    <div className="flex items-center gap-3 border-b px-5 py-4 last:border-b-0">
      <Globe className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{row.name}</span>
          <Badge variant="outline" className="font-sans">
            {row.scope === "global" ? "用户级" : "项目级"}
          </Badge>
          {row.config.disabled === true && (
            <Badge variant="secondary">已禁用</Badge>
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {summary}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <StatusDot status={row.status} />
        <span className="text-xs text-muted-foreground">
          {row.status ?? "未知"}
        </span>
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: string | null }) {
  if (status === "connected" || status === "ready") {
    return <CheckCircle2 className="size-3.5 text-connected" />
  }
  if (status === "needs-auth" || status === "needs_auth") {
    return <Circle className="size-3.5 text-warn" />
  }
  if (status === "failed" || status === "error") {
    return <XCircle className="size-3.5 text-destructive" />
  }
  return <Circle className="size-3.5 text-muted-foreground" />
}

function BrowserChip({ label, ok }: { label: string; ok?: boolean }) {
  return (
    <Badge variant={ok ? "primary" : "outline"} className="font-sans">
      {ok ? (
        <CheckCircle2 className="size-3" />
      ) : (
        <Circle className="size-3" />
      )}
      {label}
    </Badge>
  )
}
