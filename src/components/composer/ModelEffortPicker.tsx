import { useState } from "react"
import { Check, ChevronDown, AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  BUILTIN_MODELS,
  buildEffortOrder,
  effortLabel,
  effortLevelsForModel,
  effortSource,
  EMPTY_COMPOSER_PREFS,
  modelDisplayLabel,
  OPENAI_EFFORT_LEVELS,
  syncEffortToGlobal,
  type ComposerPrefs,
  type EffortLevel
} from "@/lib/composerPrefs"

interface Props {
  model: string
  effort: string
  onChange: (next: { model?: string; effort?: string }) => void
  modelOptions?: Array<{ value: string; label?: string }>
  restrictModelOptions?: boolean
  availableEffortLevels?: string[]
  openaiCompatibleProvider?: boolean
  disabled?: boolean
  globalDefault?: ComposerPrefs
  sessionPrefs?: ComposerPrefs | null
}

const PERSISTABLE_EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh"]
const MENU_LABEL_CLASS =
  "px-2 pt-1 pb-1 text-[11px] font-medium text-muted-foreground"
const MENU_ITEM_CLASS =
  "h-8 rounded-lg px-2 text-[13px] font-normal leading-5 text-popover-foreground hover:bg-primary/10 hover:text-foreground data-[highlighted]:bg-primary/10 data-[highlighted]:text-foreground"
const MENU_META_CLASS = "text-[10px] leading-none text-muted-foreground"
const MENU_CHECK_CLASS = "size-3.5 text-primary"

export function ModelEffortPicker({
  model,
  effort,
  onChange,
  modelOptions,
  restrictModelOptions = false,
  availableEffortLevels,
  openaiCompatibleProvider = false,
  disabled,
  globalDefault,
  sessionPrefs
}: Props) {
  // 档位来源按 provider 分场景（PR3）：
  // - OpenAI 兼容（openai-chat-completions）：OpenAI reasoning_effort 固定清单（auto + 6 档，
  //   含 none/minimal，无 max、无 ultracode）。OpenAI 无 --help 枚举源，走本地常量。
  // - 否则（官方直连 / 第三方 anthropic）：claude --help 动态档位 + auto + ultracode sentinel。
  const baseOrder = buildEffortOrder(availableEffortLevels ?? [])
  const effortPool: EffortLevel[] = openaiCompatibleProvider
    ? ["", ...OPENAI_EFFORT_LEVELS]
    : baseOrder
  const cap = effortLevelsForModel(model, effortPool)
  const supportsEffort = !!cap
  // ultracode 是 GUI 手动追加的 sentinel（来自 Claude Code "ultracode": true 设置，
  // 非 claude --help 的 --effort 档位）：仅在官方 / 第三方 anthropic 路径展示；
  // OpenAI 兼容隐藏（其清单本就不含它）。不进入 buildEffortOrder / effortLevelsForModel(cap)。
  const visibleEfforts: EffortLevel[] = openaiCompatibleProvider
    ? effortPool
    : [...effortPool, "ultracode"]
  const isUltracode = !openaiCompatibleProvider && effort === "ultracode"
  // 旧会话 sidecar 里可能残留 Claude 的 max；OpenAI 清单不展示 max 项，
  // 但把残留值映射为 xhigh 以正确选中/发送（与 api_proxy.rs::openai_reasoning_effort 的兜底一致）。
  const normalizedEffort =
    openaiCompatibleProvider && effort === "max" ? "xhigh" : effort
  const safeEffort: EffortLevel = isUltracode
    ? "ultracode"
    : cap && cap.available.includes(normalizedEffort as EffortLevel)
      ? (normalizedEffort as EffortLevel)
      : ""

  const modelLabel = modelDisplayLabel(model)
  const currentEffortLabel = supportsEffort ? effortLabel(safeEffort) : null
  const triggerLabel = currentEffortLabel
    ? `${modelLabel} · ${currentEffortLabel}`
    : modelLabel
  const explicitOptions = modelOptions
    ? Array.from(
        new Map(
          modelOptions
            .map((option) => ({
              value: option.value.trim(),
              label: (option.label || option.value).trim()
            }))
            .filter((option) => option.value)
            .map((option) => [option.value, option])
        ).values()
      )
    : []
  const options = modelOptions && (restrictModelOptions || explicitOptions.length)
    ? explicitOptions
    : BUILTIN_MODELS

  const baselineDefault = globalDefault ?? EMPTY_COMPOSER_PREFS
  const source = effortSource(effort, sessionPrefs ?? null, baselineDefault)
  const sourceLabel =
    source === "auto"
      ? "自动 · 跟随 CLI 默认"
      : source === "session"
        ? "本次会话覆盖"
        : "全局默认"
  const isMaxSelected = safeEffort === "max"
  const canPersistGlobal =
    PERSISTABLE_EFFORTS.includes(safeEffort) && safeEffort !== ""
  const isAlreadyGlobal =
    canPersistGlobal && baselineDefault.effort === safeEffort

  const [persisting, setPersisting] = useState(false)
  const handleSyncGlobal = async () => {
    if (!canPersistGlobal || persisting) return
    setPersisting(true)
    try {
      const ok = await syncEffortToGlobal(safeEffort)
      if (ok) {
        toast.success(`已写入 settings.json：effortLevel=${safeEffort}`)
      } else {
        toast.error("写入失败：当前级别不允许或文件不可写")
      }
    } catch (e) {
      toast.error(`写入失败: ${String(e)}`)
    } finally {
      setPersisting(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`模型与思考强度（当前 ${triggerLabel}，${sourceLabel}）`}
          title={`切换模型与思考强度\n当前：${triggerLabel} · ${sourceLabel}`}
          className={cn(
            "inline-flex h-7 max-w-[18rem] items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          {source === "session" && (
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-primary"
              title="已为本会话覆盖"
            />
          )}
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-72 overflow-y-auto rounded-2xl p-1.5 scrollbar-thin"
      >
        <DropdownMenuLabel className={MENU_LABEL_CLASS}>
          模型
        </DropdownMenuLabel>
        <DropdownMenuItem
          className={MENU_ITEM_CLASS}
          onSelect={() => onChange({ model: "" })}
        >
          <span className="flex-1">Default</span>
          {!model && <Check className={MENU_CHECK_CLASS} />}
        </DropdownMenuItem>
        {options.map((m) => (
          <DropdownMenuItem
            key={m.value}
            className={MENU_ITEM_CLASS}
            onSelect={() => onChange({ model: m.value })}
          >
            <span className="flex-1 truncate" title={m.value}>
              {m.label}
            </span>
            {model === m.value && <Check className={MENU_CHECK_CLASS} />}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        <DropdownMenuLabel className={MENU_LABEL_CLASS}>
          思考强度
          <span className="ml-2 text-[10px] font-normal normal-case">
            {sourceLabel}
          </span>
        </DropdownMenuLabel>
        {!supportsEffort ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            该模型不支持思考强度
          </div>
        ) : (
          visibleEfforts.map((lvl) => {
            const isUltra = lvl === "ultracode"
            // ultracode 不在 cap.available 里（它不是 --effort 档位），只要可见即可选
            const ok = isUltra
              ? true
              : cap!.available.includes(lvl) && visibleEfforts.includes(lvl)
            // max 与 ultracode 都是会话级、不写 settings.json 的选项
            const sessionOnly = lvl === "max" || isUltra
            return (
              <DropdownMenuItem
                key={lvl || "auto"}
                disabled={!ok}
                className={cn(
                  MENU_ITEM_CLASS,
                  !ok && "opacity-50"
                )}
                onSelect={() => {
                  // 单选互斥：选中 ultracode 即写入 effort sentinel "ultracode"
                  if (ok) onChange({ effort: lvl })
                }}
              >
                <span className="flex-1">{effortLabel(lvl)}</span>
                {sessionOnly && (
                  <span
                    className="text-[10px] text-warn"
                    title={
                      isUltra
                        ? "ultracode 仅对当前会话生效，不会写入 settings.json"
                        : "max 仅对当前会话生效，不会写入 settings.json"
                    }
                  >
                    仅本会话
                  </span>
                )}
                {!ok && (
                  <span className={MENU_META_CLASS}>
                    需切换到支持的模型
                  </span>
                )}
                {ok && safeEffort === lvl && (
                  <Check className={MENU_CHECK_CLASS} />
                )}
              </DropdownMenuItem>
            )
          })
        )}

        {supportsEffort && openaiCompatibleProvider && (
          <div className="mt-1 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground">
            OpenAI 兼容使用 reasoning_effort 档位（none / minimal / low / medium /
            high / xhigh）；具体支持取决于模型，端点不支持的档位会被忽略或回退。历史会话中的
            max 会按 xhigh 发送。
          </div>
        )}

        {supportsEffort && isMaxSelected && (
          <div className="mt-1 flex items-start gap-1.5 rounded-lg border border-warn/40 bg-warn/5 px-2.5 py-1.5 text-[11px] leading-snug text-warn">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <span>
              max 仅对当前会话生效，选择会保存在本会话中，resume 时自动传入。
            </span>
          </div>
        )}

        {supportsEffort && isUltracode && (
          <div className="mt-1 flex items-start gap-1.5 rounded-lg border border-warn/40 bg-warn/5 px-2.5 py-1.5 text-[11px] leading-snug text-warn">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <span>
              ultracode = xhigh + 自动 workflows，仅本次会话生效（resume 时还原）。
              需 Opus 4.7+ 等支持 xhigh 的模型；第三方需模型支持 xhigh + workflows，
              否则 CLI 会忽略 / 回退。
              {/* 注意：第三方若开启「最大思考强度」(CLAUDE_CODE_EFFORT_LEVEL=max)，
                  该 env 优先级最高，会覆盖此处的 ultracode 选择（见 PR4 的 UI 互斥 TODO）。 */}
            </span>
          </div>
        )}

        {supportsEffort && canPersistGlobal && (
          <DropdownMenuItem
            className={cn(MENU_ITEM_CLASS, "mt-1")}
            disabled={persisting || isAlreadyGlobal}
            onSelect={(e) => {
              e.preventDefault()
              void handleSyncGlobal()
            }}
          >
            <span className="flex-1">
              {isAlreadyGlobal
                ? "已是全局默认"
                : "设为全局默认"}
            </span>
            {!isAlreadyGlobal && (
              <span className={MENU_META_CLASS}>
                effortLevel={safeEffort}
              </span>
            )}
          </DropdownMenuItem>
        )}

      </DropdownMenuContent>
    </DropdownMenu>
  )
}
