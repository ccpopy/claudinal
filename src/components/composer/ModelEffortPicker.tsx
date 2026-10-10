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
import { fastModeStatusText, ultracodeStatusText } from "@/lib/composerCapabilities"
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
  composerModelKey,
  resolveComposerModelDefaults,
  selectComposerModel,
  patchComposerPrefs,
  parseAutoCompactWindow,
  type ComposerPrefs,
  type ComposerRuntimeConfig,
  type ComposerFeatureCapabilities,
  type ComposerModelCapabilities,
  type AutoCompactWindow,
  type EffortLevel
} from "@/lib/composerPrefs"

interface Props {
  model: string
  effort: string
  onChange: (next: Partial<ComposerPrefs>) => void
  ultracode?: boolean
  enableWorkflows?: boolean
  fastMode?: boolean
  autoCompactWindow?: AutoCompactWindow
  modelEfforts?: Record<string, string>
  canonicalModels?: Readonly<Record<string, string>>
  modelCapabilities?: Readonly<Record<string, ComposerModelCapabilities>>
  actualConfig?: ComposerRuntimeConfig | null
  actualProviderLabel?: string
  featureCapabilities?: ComposerFeatureCapabilities
  configurationPending?: boolean
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
const MENU_HINT_CLASS = "px-2 pb-1 text-[11px] leading-snug text-muted-foreground"

/** 菜单内的开关行：点击切换且不关闭菜单；hint 仅在需要用户注意时显示。 */
function FeatureToggle({ label, meta, checked, disabled, title, hint, onToggle }: {
  label: string
  meta?: string
  checked: boolean
  disabled?: boolean
  title?: string
  hint?: string | null
  onToggle: () => void
}) {
  return <>
    <DropdownMenuItem
      className={MENU_ITEM_CLASS}
      disabled={disabled}
      title={title}
      role="menuitemcheckbox"
      aria-checked={checked}
      onSelect={(event) => { event.preventDefault(); onToggle() }}
    >
      <span className="flex-1">{label}</span>
      {meta && <span className={MENU_META_CLASS}>{meta}</span>}
      <span aria-hidden className={cn("inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors", checked ? "bg-primary" : "bg-input")}>
        <span className={cn("block size-3 rounded-full bg-background shadow-sm transition-transform", checked && "translate-x-3")} />
      </span>
    </DropdownMenuItem>
    {hint && <div className={MENU_HINT_CLASS}>{hint}</div>}
  </>
}

export function ModelEffortPicker({
  model,
  effort,
  ultracode = false,
  enableWorkflows,
  fastMode = false,
  autoCompactWindow,
  modelEfforts,
  canonicalModels,
  modelCapabilities,
  actualConfig,
  actualProviderLabel,
  featureCapabilities = {},
  configurationPending = false,
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
  // - 否则（官方直连 / 第三方 anthropic）：CLI 能力检测返回的原生档位 + auto。
  const baseOrder = buildEffortOrder(availableEffortLevels ?? [])
  const effortPool: EffortLevel[] = openaiCompatibleProvider
    ? ["", ...OPENAI_EFFORT_LEVELS]
    : baseOrder
  const canonicalModel = composerModelKey(model, canonicalModels)
  const modelCapability = openaiCompatibleProvider ? undefined : modelCapabilities?.[model] ?? modelCapabilities?.[canonicalModel]
  const declaredCap = effortLevelsForModel(model, effortPool, modelCapability)
  const effortUnconfirmed = !openaiCompatibleProvider && modelCapability?.supportsEffort === undefined && modelCapability?.supportedEffortLevels === undefined
  // Help lists choices; actual model support is confirmed only by CLI metadata.
  const cap = declaredCap ?? (effortUnconfirmed ? { available: effortPool, defaultEffort: "" as EffortLevel } : null)
  const supportsEffort = !!cap
  const visibleEfforts = cap?.available ?? effortPool
  // 旧会话 sidecar 里可能残留 Claude 的 max；OpenAI 清单不展示 max 项，
  // 但把残留值映射为 xhigh 以正确选中/发送（与 api_proxy.rs::openai_reasoning_effort 的兜底一致）。
  const normalizedEffort =
    openaiCompatibleProvider && effort === "max" ? "xhigh" : effort
  const safeEffort: EffortLevel = cap && cap.available.includes(normalizedEffort as EffortLevel)
      ? (normalizedEffort as EffortLevel)
      : ""

  const modelLabel = modelDisplayLabel(model)
  const currentEffortLabel = supportsEffort ? effortLabel(safeEffort) : null
  const selectedLabel = currentEffortLabel
    ? `${modelLabel} · ${currentEffortLabel}`
    : modelLabel
  const triggerLabel = `${selectedLabel}${ultracode ? " · Ultracode" : ""}${fastMode ? " · Fast" : ""}`
  const actualLabel = actualConfig?.model
    ? `${modelDisplayLabel(actualConfig.model)} · ${effortLabel(actualConfig.effort ?? "")}${actualConfig.ultracode ? " · Ultracode" : ""}${actualConfig.fastModeState === "on" ? " · Fast" : actualConfig.fastModeState === "cooldown" ? " · Fast 冷却中" : ""}`
    : "尚未确认"
  const actualProcessLabel = `当前进程${actualProviderLabel ? `（${actualProviderLabel}）` : ""}：${actualLabel}`
  const actualFlag = (value: boolean | undefined) => value === true ? "是" : value === false ? "否" : "待确认"
  const ultraDetails = `CLI 请求：${actualFlag(actualConfig?.ultracodeRequested)} · 可用：${actualFlag(actualConfig?.ultracodeAvailable)} · 生效：${actualFlag(actualConfig?.ultracode)}`
  const fastDetails = `CLI 实际：${actualConfig?.fastModeState === "on" ? "已开启" : actualConfig?.fastModeState === "off" ? "已关闭" : actualConfig?.fastModeState === "cooldown" ? "冷却中" : "待确认"}`
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
  const defaultsForModel = resolveComposerModelDefaults(baselineDefault, model, { canonicalModels })
  const currentPrefs: ComposerPrefs = { ...sessionPrefs, model, effort, ultracode, enableWorkflows, fastMode, autoCompactWindow, modelEfforts: modelEfforts ?? sessionPrefs?.modelEfforts }
  const chooseModel = (nextModel: string) => onChange(selectComposerModel(currentPrefs, nextModel, baselineDefault, canonicalModels))
  const chooseEffort = (nextEffort: string) => onChange(patchComposerPrefs(currentPrefs, { effort: nextEffort }, baselineDefault, canonicalModels))
  const source = effortSource(effort, sessionPrefs ?? null, baselineDefault, model)
  const defaultScopeLabels = { userSettings: "用户默认", projectSettings: "项目默认", localSettings: "项目本地默认", flagSettings: "启动设置", policySettings: "托管默认" }
  const sourceLabel =
    source === "auto"
      ? "自动 · 跟随 CLI 默认"
      : source === "session"
        ? "本次会话覆盖"
        : defaultsForModel.scope ? defaultScopeLabels[defaultsForModel.scope] : "模型默认"
  const isMaxSelected = safeEffort === "max"
  const canPersistGlobal =
    PERSISTABLE_EFFORTS.includes(safeEffort) && safeEffort !== "" && !openaiCompatibleProvider
  const canWriteModel = !!canonicalModels?.[model] || /^claude-[^\s]+$/.test(canonicalModel)
  const isAlreadyGlobal =
    canPersistGlobal && baselineDefault.modelSettings?.[canonicalModel]?.effortLevel === safeEffort

  const [persisting, setPersisting] = useState(false)
  const handleSyncGlobal = async () => {
    if (!canPersistGlobal || !canWriteModel || persisting) return
    setPersisting(true)
    try {
      const ok = await syncEffortToGlobal(safeEffort, canonicalModel)
      if (ok) {
        toast.success(`已保存 ${modelLabel} 的默认思考强度：${effortLabel(safeEffort)}`)
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
          title={`已选择：${triggerLabel} · ${sourceLabel}\n${actualProcessLabel}\n${configurationPending ? "配置待应用" : "修改用于下一次请求；运行中的请求保持原配置"}`}
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
        {/* 仅在配置待应用时提示；完整的所选/实际配置见触发按钮的悬停说明 */}
        {configurationPending && (
          <div
            className="px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground"
            title="修改从下一次请求生效，进行中的请求保持原配置"
          >
            配置待应用 · {actualProcessLabel}
          </div>
        )}
        <DropdownMenuLabel className={MENU_LABEL_CLASS}>
          模型
        </DropdownMenuLabel>
        <DropdownMenuItem
          className={MENU_ITEM_CLASS}
          onSelect={() => chooseModel("")}
        >
          <span className="flex-1">Default</span>
          {!model && <Check className={MENU_CHECK_CLASS} />}
        </DropdownMenuItem>
        {options.map((m) => (
          <DropdownMenuItem
            key={m.value}
            className={MENU_ITEM_CLASS}
            onSelect={() => chooseModel(m.value)}
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
        {effortUnconfirmed && <div className={MENU_HINT_CLASS}>档位待 CLI 确认</div>}
        {!supportsEffort ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {modelCapability?.supportsEffort === false ? "CLI 确认该模型不支持思考强度" : "该模型的思考强度能力尚未确认；保持 CLI 默认"}
          </div>
        ) : (
          visibleEfforts.map((lvl) => {
            const ok = cap!.available.includes(lvl)
            const sessionOnly = lvl === "max"
            return (
              <DropdownMenuItem
                key={lvl || "auto"}
                disabled={!ok}
                className={cn(
                  MENU_ITEM_CLASS,
                  !ok && "opacity-50"
                )}
                onSelect={() => {
                  // Pass through the selected native effort value.
                  if (ok) chooseEffort(lvl)
                }}
              >
                <span className="flex-1">{effortLabel(lvl)}</span>
                {sessionOnly && (
                  <span
                    className="text-[10px] text-warn"
                    title="max 仅在本次进程/会话中使用，不写入永久默认"
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
          <div className={MENU_HINT_CLASS} title="端点不支持的档位会被忽略或回退；历史会话中的 max 按 xhigh 发送">
            OpenAI 兼容：使用 reasoning_effort 档位
          </div>
        )}

        {supportsEffort && isMaxSelected && (
          <div className="mt-1 flex items-start gap-1.5 rounded-lg border border-warn/40 bg-warn/5 px-2.5 py-1.5 text-[11px] leading-snug text-warn">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <span>max 仅对本会话生效，不写入默认</span>
          </div>
        )}

        {!openaiCompatibleProvider && <>
          <DropdownMenuSeparator />
          <FeatureToggle
            label="Ultracode"
            checked={ultracode}
            disabled={!featureCapabilities.independentUltracode}
            title={`独立于思考强度的开关；需 Dynamic workflows，并受模型与组织策略限制\n${ultraDetails}`}
            hint={featureCapabilities.independentUltracode
              ? ultracodeStatusText(ultracode, actualConfig, configurationPending || (ultracode && actualConfig?.ultracodeRequested === undefined))
              : featureCapabilities.ultracodeReason ?? "当前 CLI 尚未确认支持"}
            onToggle={() => onChange({ ultracode: !ultracode })}
          />
          <FeatureToggle
            label="Dynamic workflows"
            meta={enableWorkflows === undefined ? "跟随 CLI" : undefined}
            checked={enableWorkflows === true}
            disabled={!featureCapabilities.independentUltracode}
            title="仅对本会话生效并随会话恢复，不修改永久设置"
            onToggle={() => onChange({ enableWorkflows: enableWorkflows !== true })}
          />
          <FeatureToggle
            label="Fast mode"
            checked={fastMode}
            disabled={!featureCapabilities.fastMode}
            title={`可能按更高单价计费或消耗 Usage credits；需支持的模型、账号与上游授权\n${fastDetails}`}
            hint={featureCapabilities.fastMode
              ? fastModeStatusText(fastMode, actualConfig, configurationPending || (fastMode && !actualConfig?.fastModeState))
              : featureCapabilities.fastModeReason ?? "当前运行环境尚未确认支持"}
            onToggle={() => onChange({ fastMode: !fastMode })}
          />
          <DropdownMenuLabel className={MENU_LABEL_CLASS} title="auto 跟随模型默认；窗口大小不代表当前上下文用量">此模型自动压缩窗口</DropdownMenuLabel>
          <div className="flex items-center gap-2 px-2 py-1">
            <input aria-label="此模型自动压缩窗口（token）" className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs" disabled={!featureCapabilities.autoCompactWindow} key={`${model}:${autoCompactWindow ?? "auto"}`} defaultValue={autoCompactWindow ?? "auto"} placeholder="auto 或 100000–1000000" onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur() }
            }} onBlur={(event) => {
              const raw = event.currentTarget.value.trim()
              const value = parseAutoCompactWindow(raw === "auto" || !raw ? "auto" : Number(raw))
              if (value === undefined) { toast.error("自动压缩窗口须为 auto 或 100000–1000000 token"); event.currentTarget.value = String(autoCompactWindow ?? "auto"); return }
              if (value !== (autoCompactWindow ?? "auto")) onChange({ autoCompactWindow: value })
            }} />
            <span className={MENU_META_CLASS}>token</span>
          </div>
          {!featureCapabilities.autoCompactWindow && <div className={MENU_HINT_CLASS}>{featureCapabilities.autoCompactWindowReason ?? "当前 CLI 尚未确认支持按模型设置"}</div>}
        </>}

        {supportsEffort && canPersistGlobal && (
          <DropdownMenuItem
            className={cn(MENU_ITEM_CLASS, "mt-1")}
            disabled={persisting || isAlreadyGlobal || !canWriteModel}
            onSelect={(e) => {
              e.preventDefault()
              void handleSyncGlobal()
            }}
          >
            <span className="flex-1">
              {isAlreadyGlobal
                ? "已是此模型用户默认"
                : canWriteModel ? "设为此模型用户默认" : "模型规范名称尚未确认"}
            </span>
            {!isAlreadyGlobal && (
              <span className={MENU_META_CLASS}>
                {effortLabel(safeEffort)}
              </span>
            )}
          </DropdownMenuItem>
        )}

      </DropdownMenuContent>
    </DropdownMenu>
  )
}
