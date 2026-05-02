import { useCallback, useState } from "react"
import { ArrowDown, ArrowUp, ExternalLink, Plus, RotateCcw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { openExternal } from "@/lib/ipc"
import {
  loadPricing,
  makePricingId,
  resetPricingToDefault,
  savePricing,
  type PricingConfig,
  type PricingGroup,
  type PricingRule
} from "@/lib/pricing"

interface PendingDelete {
  kind: "group" | "rule"
  groupId: string
  ruleId?: string
  label: string
}

const PRICE_FIELDS: Array<{
  key: keyof Pick<
    PricingRule,
    "input" | "output" | "cacheRead" | "cacheWrite" | "multiplier"
  >
  label: string
  title: string
  step: number
}> = [
  { key: "input", label: "输入", title: "输入（USD/1M tokens）", step: 0.001 },
  { key: "output", label: "输出", title: "输出（USD/1M tokens）", step: 0.001 },
  {
    key: "cacheRead",
    label: "缓存命中",
    title: "缓存命中（USD/1M tokens）",
    step: 0.001
  },
  {
    key: "cacheWrite",
    label: "缓存创建",
    title: "缓存创建（USD/1M tokens）",
    step: 0.001
  },
  {
    key: "multiplier",
    label: "倍率",
    title: "折扣/加成倍率，最终计费 = 标价 × 倍率（默认 1）",
    step: 0.01
  }
]

const SOURCE_LINKS: Array<{ name: string; url: string }> = [
  {
    name: "Anthropic",
    url: "https://platform.claude.com/docs/en/docs/about-claude/pricing"
  },
  {
    name: "OpenAI",
    url: "https://developers.openai.com/api/docs/pricing"
  },
  {
    name: "DeepSeek",
    url: "https://api-docs.deepseek.com/quick_start/pricing"
  }
]

export function PricingEditor() {
  const [config, setConfig] = useState<PricingConfig>(() => loadPricing())
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [pendingReset, setPendingReset] = useState(false)

  const commit = useCallback((next: PricingConfig) => {
    try {
      savePricing(next)
      setConfig(next)
    } catch (error) {
      console.error("保存定价配置失败:", error)
      toast.error(`保存定价配置失败: ${String(error)}`)
    }
  }, [])

  const updateGroup = (groupId: string, patch: Partial<PricingGroup>) => {
    commit({
      ...config,
      groups: config.groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g))
    })
  }

  const updateRule = (
    groupId: string,
    ruleId: string,
    patch: Partial<PricingRule>
  ) => {
    commit({
      ...config,
      groups: config.groups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              rules: g.rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r))
            }
          : g
      )
    })
  }

  const addGroup = () => {
    const next: PricingGroup = {
      id: makePricingId(),
      name: "新分组",
      rules: []
    }
    commit({ ...config, groups: [...config.groups, next] })
  }

  const addRule = (groupId: string) => {
    const next: PricingRule = {
      id: makePricingId(),
      pattern: "",
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      multiplier: 1
    }
    commit({
      ...config,
      groups: config.groups.map((g) =>
        g.id === groupId ? { ...g, rules: [...g.rules, next] } : g
      )
    })
  }

  const moveRule = (groupId: string, ruleId: string, direction: -1 | 1) => {
    commit({
      ...config,
      groups: config.groups.map((g) => {
        if (g.id !== groupId) return g
        const idx = g.rules.findIndex((r) => r.id === ruleId)
        if (idx < 0) return g
        const target = idx + direction
        if (target < 0 || target >= g.rules.length) return g
        const rules = g.rules.slice()
        const [item] = rules.splice(idx, 1)
        rules.splice(target, 0, item)
        return { ...g, rules }
      })
    })
  }

  const deleteGroup = (groupId: string) => {
    commit({ ...config, groups: config.groups.filter((g) => g.id !== groupId) })
  }

  const deleteRule = (groupId: string, ruleId: string) => {
    commit({
      ...config,
      groups: config.groups.map((g) =>
        g.id === groupId
          ? { ...g, rules: g.rules.filter((r) => r.id !== ruleId) }
          : g
      )
    })
  }

  const handleReset = () => {
    try {
      const next = resetPricingToDefault()
      setConfig(next)
      setPendingReset(false)
      toast.success("已恢复官方默认定价")
    } catch (error) {
      console.error("恢复默认定价失败:", error)
      toast.error(`恢复默认定价失败: ${String(error)}`)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <div className="text-xs text-muted-foreground">
          按组管理模型 ID 与价格；规则按组内顺序匹配，命中即停（特殊在前、宽泛在后）。
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPendingReset(true)}
          >
            <RotateCcw className="size-3.5" />
            恢复官方默认
          </Button>
          <Button type="button" size="sm" onClick={addGroup}>
            <Plus className="size-3.5" />
            新增分组
          </Button>
        </div>
      </div>

      <div className="space-y-6 pb-2 pt-4">
        {config.groups.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center rounded-lg border border-dashed text-center">
            <div className="text-sm font-medium">还没有任何定价分组</div>
            <div className="mt-1 text-xs text-muted-foreground">
              点击右上角「新增分组」开始配置。
            </div>
          </div>
        ) : (
          config.groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              onRename={(name) => updateGroup(group.id, { name })}
              onAddRule={() => addRule(group.id)}
              onDeleteGroup={() =>
                setPendingDelete({
                  kind: "group",
                  groupId: group.id,
                  label: group.name
                })
              }
              onUpdateRule={(ruleId, patch) =>
                updateRule(group.id, ruleId, patch)
              }
              onMoveRule={(ruleId, dir) => moveRule(group.id, ruleId, dir)}
              onDeleteRule={(rule) =>
                setPendingDelete({
                  kind: "rule",
                  groupId: group.id,
                  ruleId: rule.id,
                  label: rule.pattern || "未命名规则"
                })
              }
            />
          ))
        )}

        <section className="rounded-lg border bg-muted/30 p-4 text-xs text-muted-foreground space-y-2">
          <div className="font-medium text-foreground">价格来源</div>
          <div>
            预设价格于 2026-05-02 从下列官方源校对：
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {SOURCE_LINKS.map((src) => (
              <button
                key={src.name}
                type="button"
                onClick={() =>
                  openExternal(src.url).catch((e) => toast.error(String(e)))
                }
                className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
              >
                <ExternalLink className="size-3" />
                {src.name}
              </button>
            ))}
          </div>
          <div>
            OpenAI / DeepSeek 官方价格表均无「缓存创建」单独计费维度，预设留 0；如代理厂商对该维度另收费，可手动填入。
          </div>
          <div>
            DeepSeek 价格按官方标价（cache miss）填充；如遇限时优惠或代理加价，可自行调整「倍率」。倍率默认 1，最终计费 = 标价 × 倍率。
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title={pendingDelete?.kind === "group" ? "删除分组" : "删除规则"}
        description={
          pendingDelete ? (
            <span>
              将删除{" "}
              <code className="font-mono">{pendingDelete.label}</code>
              {pendingDelete.kind === "group" ? "（包含其下所有规则）" : ""}。
            </span>
          ) : null
        }
        confirmText="删除"
        destructive
        onConfirm={() => {
          if (!pendingDelete) return
          if (pendingDelete.kind === "group") {
            deleteGroup(pendingDelete.groupId)
          } else if (pendingDelete.ruleId) {
            deleteRule(pendingDelete.groupId, pendingDelete.ruleId)
          }
          setPendingDelete(null)
        }}
      />

      <ConfirmDialog
        open={pendingReset}
        onOpenChange={(open) => {
          if (!open) setPendingReset(false)
        }}
        title="恢复官方默认定价"
        description={
          <span>
            将丢弃当前所有自定义分组与规则，恢复为官方预设的 Anthropic / OpenAI / DeepSeek 三组。
          </span>
        }
        confirmText="恢复默认"
        destructive
        onConfirm={handleReset}
      />
    </>
  )
}

function GroupCard({
  group,
  onRename,
  onAddRule,
  onDeleteGroup,
  onUpdateRule,
  onMoveRule,
  onDeleteRule
}: {
  group: PricingGroup
  onRename: (name: string) => void
  onAddRule: () => void
  onDeleteGroup: () => void
  onUpdateRule: (ruleId: string, patch: Partial<PricingRule>) => void
  onMoveRule: (ruleId: string, dir: -1 | 1) => void
  onDeleteRule: (rule: PricingRule) => void
}) {
  return (
    <section className="rounded-lg border bg-card p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          value={group.name}
          onChange={(e) => onRename(e.target.value)}
          placeholder="分组名称"
          className="h-9 max-w-[260px] text-sm font-medium"
        />
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onAddRule}>
            <Plus className="size-3.5" />
            新增模型规则
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            onClick={onDeleteGroup}
            aria-label={`删除分组 ${group.name}`}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {group.rules.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
          暂无规则。点击右上角「新增模型规则」添加。
        </div>
      ) : (
        <div className="space-y-3">
          <RuleHeaderRow />
          {group.rules.map((rule, index) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              canMoveUp={index > 0}
              canMoveDown={index < group.rules.length - 1}
              onUpdate={(patch) => onUpdateRule(rule.id, patch)}
              onMoveUp={() => onMoveRule(rule.id, -1)}
              onMoveDown={() => onMoveRule(rule.id, 1)}
              onDelete={() => onDeleteRule(rule)}
            />
          ))}
          <div className="text-[11px] text-muted-foreground/70">
            示例：<code className="font-mono">*claude-opus-4-7*</code> 可命中{" "}
            <code className="font-mono">claude-opus-4-7</code>、
            <code className="font-mono">azure/claude-opus-4-7-20260101</code>。
          </div>
        </div>
      )}
    </section>
  )
}

function RuleHeaderRow() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_repeat(5,minmax(0,84px))_72px] items-center gap-2 px-1 text-[11px] uppercase tracking-wider text-muted-foreground">
      <Label className="text-[11px]">模型 ID（glob）</Label>
      {PRICE_FIELDS.map((f) => (
        <Label
          key={f.key}
          className="justify-self-center text-center text-[11px]"
          title={f.title}
        >
          {f.label}
        </Label>
      ))}
      <span />
    </div>
  )
}

function RuleRow({
  rule,
  canMoveUp,
  canMoveDown,
  onUpdate,
  onMoveUp,
  onMoveDown,
  onDelete
}: {
  rule: PricingRule
  canMoveUp: boolean
  canMoveDown: boolean
  onUpdate: (patch: Partial<PricingRule>) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_repeat(5,minmax(0,84px))_72px] items-center gap-2">
      <Input
        value={rule.pattern}
        onChange={(e) => onUpdate({ pattern: e.target.value })}
        placeholder="*claude-opus-4-7*"
        className="font-mono text-xs"
      />
      {PRICE_FIELDS.map((f) => (
        <NumberInput
          key={f.key}
          value={rule[f.key]}
          step={f.step}
          onChange={(v) => onUpdate({ [f.key]: v } as Partial<PricingRule>)}
        />
      ))}
      <div className="flex items-center justify-end gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          disabled={!canMoveUp}
          onClick={onMoveUp}
          aria-label="上移"
        >
          <ArrowUp className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          disabled={!canMoveDown}
          onClick={onMoveDown}
          aria-label="下移"
        >
          <ArrowDown className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label="删除规则"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

function NumberInput({
  value,
  step = 0.001,
  onChange
}: {
  value: number
  step?: number
  onChange: (v: number) => void
}) {
  return (
    <Input
      type="number"
      min={0}
      step={step}
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => {
        const next = Number(e.target.value)
        onChange(Number.isFinite(next) && next >= 0 ? next : 0)
      }}
      className="h-8 text-right font-mono text-xs tabular-nums"
    />
  )
}
