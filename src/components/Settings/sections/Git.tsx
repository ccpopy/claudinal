import { useCallback, useEffect, useState } from "react"
import { ExternalLink, GitBranch, RefreshCw, Save, Terminal } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  claudeSettingsPath,
  githubCliStatus,
  type GithubCliStatus,
  openExternal,
  openPath,
  readClaudeMd,
  readClaudeSettings,
  writeClaudeMd,
  writeClaudeSettings
} from "@/lib/ipc"
import { buildProxyEnv, loadProxyAsync } from "@/lib/proxy"
import {
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionHeader
} from "./layout"

interface AttributionSettings {
  commit: string
  pr: string
}

// settings.json 的 Git 字段（Claude Code 文档：https://code.claude.com/docs/en/settings）
interface GitSettings {
  attribution: AttributionSettings
  includeGitInstructions: boolean
  prUrlTemplate?: string
}

const EMPTY_ATTRIBUTION: AttributionSettings = {
  commit: "",
  pr: ""
}
const DEFAULT_GIT_SETTINGS: GitSettings = {
  attribution: EMPTY_ATTRIBUTION,
  includeGitInstructions: false
}
const CLAUDE_ATTRIBUTION = "Generated with [Claude Code](https://claude.com/claude-code)"
const CLAUDE_CO_AUTHOR = "Co-Authored-By: Claude <noreply@anthropic.com>"
const DEFAULT_ATTRIBUTION: AttributionSettings = {
  commit: `${CLAUDE_ATTRIBUTION}\n\n${CLAUDE_CO_AUTHOR}`,
  pr: CLAUDE_ATTRIBUTION
}

// 提交 / PR 指令：仅本地 store + 显式同步到 CLAUDE.md 的哨兵区段
const INSTR_KEY = "claudinal.git-instructions"
const COMMIT_SENTINEL_START = "<!-- CLAUDINAL:GIT_COMMIT_INSTRUCTIONS -->"
const COMMIT_SENTINEL_END = "<!-- /CLAUDINAL:GIT_COMMIT_INSTRUCTIONS -->"
const PR_SENTINEL_START = "<!-- CLAUDINAL:GIT_PR_INSTRUCTIONS -->"
const PR_SENTINEL_END = "<!-- /CLAUDINAL:GIT_PR_INSTRUCTIONS -->"

interface GitInstructions {
  commit: string
  pr: string
}

function loadInstructions(): GitInstructions {
  try {
    const raw = localStorage.getItem(INSTR_KEY)
    if (!raw) return { commit: "", pr: "" }
    const obj = JSON.parse(raw)
    return {
      commit: typeof obj?.commit === "string" ? obj.commit : "",
      pr: typeof obj?.pr === "string" ? obj.pr : ""
    }
  } catch {
    return { commit: "", pr: "" }
  }
}

function saveInstructions(v: GitInstructions) {
  try {
    localStorage.setItem(INSTR_KEY, JSON.stringify(v))
  } catch {
    // ignore
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function replaceSentinelBlock(
  body: string,
  start: string,
  end: string,
  contents: string
): string {
  const re = new RegExp(
    `\\n*${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}\\n?`,
    "g"
  )
  const stripped = body.replace(re, "")
  if (!contents.trim()) return stripped.replace(/\s+$/, "") + "\n"
  const block = `${start}\n${contents.trim()}\n${end}`
  const head = stripped.replace(/\s+$/, "")
  return (head ? head + "\n\n" : "") + block + "\n"
}

function readAttribution(value: unknown): AttributionSettings {
  if (value === undefined) return { ...EMPTY_ATTRIBUTION }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings.json 中 attribution 必须是对象：{ commit, pr }")
  }
  const obj = value as Record<string, unknown>
  if (
    (obj.commit !== undefined && typeof obj.commit !== "string") ||
    (obj.pr !== undefined && typeof obj.pr !== "string")
  ) {
    throw new Error("settings.json 中 attribution.commit 和 attribution.pr 必须是字符串")
  }
  return {
    commit: obj.commit ?? "",
    pr: obj.pr ?? ""
  }
}

function hasAttribution(attribution: AttributionSettings): boolean {
  return Boolean(attribution.commit.trim() || attribution.pr.trim())
}

export function Git() {
  const [raw, setRaw] = useState<Record<string, unknown>>({})
  const [cur, setCur] = useState<GitSettings>(DEFAULT_GIT_SETTINGS)
  const [filePath, setFilePath] = useState("")
  const [loading, setLoading] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [gh, setGh] = useState<GithubCliStatus | null>(null)
  const [ghLoading, setGhLoading] = useState(false)

  const [instructions, setInstructions] = useState<GitInstructions>(() =>
    loadInstructions()
  )
  const [commitDirty, setCommitDirty] = useState(false)
  const [prDirty, setPrDirty] = useState(false)
  const [syncingCommit, setSyncingCommit] = useState(false)
  const [syncingPr, setSyncingPr] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const path = await claudeSettingsPath("global")
      setFilePath(path)
      const data = ((await readClaudeSettings("global")) ?? {}) as Record<
        string,
        unknown
      >
      setRaw(data)
      const attribution = readAttribution(data.attribution)
      const sub: GitSettings = {
        attribution,
        includeGitInstructions: data.includeGitInstructions === true,
        prUrlTemplate:
          typeof data.prUrlTemplate === "string" ? data.prUrlTemplate : undefined
      }
      setCur(sub)
      setDirty(
        data.attribution === undefined ||
          data.includeGitInstructions === undefined ||
          data.includeCoAuthoredBy !== undefined
      )
    } catch (e) {
      toast.error(`读取失败: ${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadGh = useCallback(async () => {
    setGhLoading(true)
    try {
      // 走 GUI 代理：socks5 由后端桥接成本地 HTTP CONNECT 代理后注入 gh 子进程
      let proxyEnv: Record<string, string> | undefined
      try {
        proxyEnv = buildProxyEnv(await loadProxyAsync())
      } catch {
        proxyEnv = undefined
      }
      setGh(await githubCliStatus(proxyEnv))
    } catch (e) {
      setGh({
        installed: false,
        path: null,
        version: null,
        authenticated: false,
        user: null,
        message: String(e)
      })
    } finally {
      setGhLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    loadGh()
  }, [load, loadGh])

  const update = (patch: Partial<GitSettings>) => {
    setCur((c) => ({ ...c, ...patch }))
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      const next: Record<string, unknown> = { ...raw }
      next.attribution = {
        commit: cur.attribution.commit,
        pr: cur.attribution.pr
      }
      next.includeGitInstructions = cur.includeGitInstructions
      delete next.includeCoAuthoredBy
      if (cur.prUrlTemplate?.trim()) {
        next.prUrlTemplate = cur.prUrlTemplate.trim()
      } else {
        delete next.prUrlTemplate
      }
      await writeClaudeSettings("global", next)
      setRaw(next)
      setDirty(false)
      toast.success("已保存到 settings.json")
    } catch (e) {
      toast.error(`保存失败: ${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const syncBlock = async (kind: "commit" | "pr") => {
    const setBusy = kind === "commit" ? setSyncingCommit : setSyncingPr
    const setDirtyFlag = kind === "commit" ? setCommitDirty : setPrDirty
    const start = kind === "commit" ? COMMIT_SENTINEL_START : PR_SENTINEL_START
    const end = kind === "commit" ? COMMIT_SENTINEL_END : PR_SENTINEL_END
    const contents = kind === "commit" ? instructions.commit : instructions.pr
    setBusy(true)
    try {
      const body = await readClaudeMd("global")
      const next = replaceSentinelBlock(body, start, end, contents)
      await writeClaudeMd("global", next)
      saveInstructions(instructions)
      setDirtyFlag(false)
      toast.success(
        contents.trim()
          ? "已同步到 ~/.claude/CLAUDE.md"
          : "已从 CLAUDE.md 移除该段"
      )
    } catch (e) {
      toast.error(`同步失败: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const attributionEnabled = hasAttribution(cur.attribution)

  return (
    <SettingsSection>
      <SettingsSectionHeader
        icon={GitBranch}
        title="Git"
        actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            filePath && openPath(filePath).catch((e) => toast.error(String(e)))
          }
          disabled={!filePath}
        >
          <ExternalLink className="size-3.5" />
          打开 settings.json
        </Button>
        }
      />

      <SettingsSectionBody>
          <section className="overflow-hidden rounded-lg border bg-card">
            <SwitchRow
              label="提交 / PR 署名"
              hint="commit 与 PR 末尾追加 Generated with Claude Code 注脚"
              checked={attributionEnabled}
              onChange={(v) =>
                update({
                  attribution: v ? DEFAULT_ATTRIBUTION : EMPTY_ATTRIBUTION
                })
              }
              disabled={loading}
            />
            <SwitchRow
              label="注入 Git 工作流指令"
              hint="把 Claude Code 内置的 Git 提交 / PR 流程指令注入 system prompt"
              checked={cur.includeGitInstructions}
              onChange={(v) => update({ includeGitInstructions: v })}
              disabled={loading}
            />
            <InputRow
              label="PR URL 模板"
              hint="无 gh CLI 时构造 PR URL 用；留空走 Claude Code 内置默认"
              value={cur.prUrlTemplate ?? ""}
              onChange={(v) => update({ prUrlTemplate: v })}
              placeholder="https://github.com/{owner}/{repo}/compare/{base}...{branch}?expand=1"
              disabled={loading}
            />
            <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
              {dirty && <span className="text-xs text-warn">未保存</span>}
              <Button
                onClick={save}
                disabled={!dirty || loading || saving}
                size="sm"
              >
                <Save className="size-3.5" />
                保存
              </Button>
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border bg-card">
            <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Terminal className="size-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">GitHub CLI</h3>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  用于从 GUI 判断 gh 是否可用。认证检测会经 GUI 代理联网验证 token。
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={loadGh}
                disabled={ghLoading}
              >
                <RefreshCw className={ghLoading ? "size-3.5 animate-spin" : "size-3.5"} />
                刷新
              </Button>
            </div>
            <div className="space-y-2 px-5 py-4 text-sm">
              <StatusLine
                label="安装状态"
                value={gh?.installed ? "已安装" : "未安装"}
                tone={gh?.installed ? "ok" : "warn"}
              />
              <StatusLine
                label="认证状态"
                value={
                  gh?.authenticated
                    ? gh.user
                      ? `已登录为 ${gh.user}`
                      : "已认证"
                    : "未认证"
                }
                tone={gh?.authenticated ? "ok" : "warn"}
              />
              {gh?.version && <StatusLine label="版本" value={gh.version} />}
              {gh?.path && <StatusLine label="路径" value={gh.path} mono />}
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    navigator.clipboard
                      .writeText("gh auth login")
                      .then(() => toast.success("命令已复制"))
                      .catch((e) => toast.error(String(e)))
                  }
                >
                  复制 gh auth login
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    openExternal("https://cli.github.com/manual/gh_auth_login").catch((e) =>
                      toast.error(String(e))
                    )
                  }
                >
                  <ExternalLink className="size-3.5" />
                  认证文档
                </Button>
              </div>
              {gh?.message && (
                <p className="text-xs text-muted-foreground">{gh.message}</p>
              )}
            </div>
          </section>

          <InstructionBlock
            title="提交指令"
            hint="保存后追加到 ~/.claude/CLAUDE.md，Claude 在所有项目生成 commit 信息时都会读到"
            value={instructions.commit}
            onChange={(v) => {
              setInstructions((i) => ({ ...i, commit: v }))
              setCommitDirty(true)
            }}
            placeholder="添加提交消息指引…"
            dirty={commitDirty}
            busy={syncingCommit}
            onSave={() => syncBlock("commit")}
          />

          <InstructionBlock
            title="拉取请求指令"
            hint="保存后追加到 ~/.claude/CLAUDE.md，Claude 生成 PR 标题 / 描述时会参考"
            value={instructions.pr}
            onChange={(v) => {
              setInstructions((i) => ({ ...i, pr: v }))
              setPrDirty(true)
            }}
            placeholder="添加拉取请求指引…"
            dirty={prDirty}
            busy={syncingPr}
            onSave={() => syncBlock("pr")}
          />
      </SettingsSectionBody>
    </SettingsSection>
  )
}

function StatusLine({
  label,
  value,
  tone,
  mono
}: {
  label: string
  value: string
  tone?: "ok" | "warn"
  mono?: boolean
}) {
  const color =
    tone === "ok"
      ? "text-connected"
      : tone === "warn"
        ? "text-warn"
        : "text-foreground"
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={`${color} min-w-0 truncate ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </span>
    </div>
  )
}

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0">
      <div className="min-w-0">
        <Label className="text-sm">{label}</Label>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {hint}
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  )
}

function InputRow({
  label,
  hint,
  value,
  onChange,
  placeholder,
  disabled
}: {
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0">
      <div className="min-w-0 flex-1 basis-[200px]">
        <Label className="text-sm">{label}</Label>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {hint}
        </div>
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full max-w-[320px] font-mono text-xs"
      />
    </div>
  )
}

function InstructionBlock({
  title,
  hint,
  value,
  onChange,
  placeholder,
  dirty,
  busy,
  onSave
}: {
  title: string
  hint: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  dirty: boolean
  busy: boolean
  onSave: () => void
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        </div>
        <Button
          onClick={onSave}
          disabled={!dirty || busy}
          size="sm"
          variant="outline"
        >
          <Save className="size-3.5" />
          保存
        </Button>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={busy}
        rows={6}
        className="text-sm"
      />
    </section>
  )
}
