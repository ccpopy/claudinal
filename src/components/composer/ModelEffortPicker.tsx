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
  EFFORT_LABELS,
  EFFORT_ORDER,
  effortLevelsForModel,
  effortSource,
  EMPTY_COMPOSER_PREFS,
  modelDisplayLabel,
  syncEffortToGlobal,
  type ComposerPrefs,
  type EffortLevel
} from "@/lib/composerPrefs"

interface Props {
  model: string
  effort: string
  onChange: (next: { model?: string; effort?: string }) => void
  modelOptions?: Array<{ value: string; label?: string }>
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
  disabled,
  globalDefault,
  sessionPrefs
}: Props) {
  const cap = effortLevelsForModel(model)
  const supportsEffort = !!cap
  const safeEffort: EffortLevel =
    cap && cap.available.includes(effort as EffortLevel)
      ? (effort as EffortLevel)
      : ""

  const modelLabel = modelDisplayLabel(model)
  const effortLabel = supportsEffort ? EFFORT_LABELS[safeEffort] : null
  const triggerLabel = effortLabel ? `${modelLabel} · ${effortLabel}` : modelLabel
  const options = modelOptions?.length
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
    : BUILTIN_MODELS

  const baselineDefault = globalDefault ?? EMPTY_COMPOSER_PREFS
  const source = effortSource(effort, sessionPrefs ?? null, baselineDefault)
  const sourceLabel =
    source === "auto"
      ? "Auto · 跟随 CLI 默认"
      : source === "session"
        ? "本会话覆盖"
        : `默认 · 来自 settings.json`
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
          EFFORT_ORDER.map((lvl) => {
            const ok = cap!.available.includes(lvl)
            const isMax = lvl === "max"
            return (
              <DropdownMenuItem
                key={lvl || "auto"}
                disabled={!ok}
                className={cn(
                  MENU_ITEM_CLASS,
                  !ok && "opacity-50"
                )}
                onSelect={() => {
                  if (ok) onChange({ effort: lvl })
                }}
              >
                <span className="flex-1">{EFFORT_LABELS[lvl]}</span>
                {isMax && (
                  <span
                    className="text-[10px] text-warn"
                    title="官方约束：max 仅当前会话有效，不会写入 settings.json"
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

        {supportsEffort && isMaxSelected && (
          <div className="mt-1 flex items-start gap-1.5 rounded-lg border border-warn/40 bg-warn/5 px-2.5 py-1.5 text-[11px] leading-snug text-warn">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <span>
              max 仅对当前会话生效（官方约束）。GUI 会在本会话 sidecar 里
              记住你的选择，resume 时自动重新传入。
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
                : "同步为全局默认（写 settings.json）"}
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
