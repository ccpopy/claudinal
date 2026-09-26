import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  useLayoutEffect,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode
} from "react"
import {
  ArrowUp,
  Blocks,
  Bot,
  Check,
  ChevronDown,
  CornerDownRight,
  ListPlus,
  FileText,
  GitBranch,
  Image as ImageIcon,
  ListTodo,
  Loader2,
  Package,
  Paperclip,
  Plus,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Square,
  X
} from "lucide-react"
import { toast } from "sonner"
import { canClearSubmittedDraft, type SubmitOutcome } from "@/lib/submission"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { composerCommandPrefix } from "@/lib/composerCommand"
import { CommandChip } from "./CommandChip"
import {
  cloneComposerDraft,
  emptyComposerDraft,
  type ComposerDraft,
  type ComposerDraftDocument,
  type ComposerDraftFileAttachment,
  type ComposerDraftImage
} from "@/lib/composerDrafts"
import {
  gitBranchList,
  gitCheckoutBranch,
  gitWorktreeStatus,
  listFiles,
  type GitBranchList,
  type GitWorktreeStatus,
  type OauthUsage,
  type OauthUsageWindow
} from "@/lib/ipc"
import type { ComposerPrefs } from "@/lib/composerPrefs"
import type { AppSettings } from "@/lib/settings"
import { listInstalledPlugins, type InstalledPlugin } from "@/lib/plugins"
import { loadSettings } from "@/lib/settings"
import {
  formatBytes,
  isDocxFile,
  isLegacyWordDocFile,
  isPdfFile,
  isSupportedUploadFile,
  pastedTextFileName,
  shouldAttachPastedText,
  supportedImageMime,
  SUPPORTED_ATTACHMENT_ACCEPT,
  utf8ByteLength
} from "@/lib/fileAttachments"
import { extractDocxText } from "@/lib/docxText"
import {
  parseTrigger,
  triggerSignature,
  type TriggerInfo
} from "@/lib/suggestionTrigger"
import { shortResets, fiveHourPercent } from "@/lib/oauthUsage"
import type { DocumentPayload, ImagePayload } from "@/types/ui"
import {
  SuggestionPanel,
  type SuggestionItem
} from "./SuggestionPanel"
import { ImageLightbox } from "./ImageLightbox"
import { ModelEffortPicker } from "./composer/ModelEffortPicker"

interface Props {
  onBeforeSend?: (
    text: string,
    images: ImagePayload[],
    documents: DocumentPayload[]
  ) => boolean | Promise<boolean>
  onSend: (
    text: string,
    images: ImagePayload[],
    documents: DocumentPayload[],
    options?: { mode?: "guide" | "followup" }
  ) => SubmitOutcome | Promise<SubmitOutcome>
  onStop: () => void | Promise<void>
  onRecallQueued?: () => void
  streaming: boolean
  /** 软中断进行中：停止按钮转为 spinner 并禁用（由 App 从 activeRun 派生） */
  interrupting?: boolean
  disabled?: boolean
  centered?: boolean
  draftKey?: string
  initialDraft?: ComposerDraft
  onDraftChange?: (draft: ComposerDraft) => void
  externalText?: string
  externalImages?: ImagePayload[]
  externalDocuments?: DocumentPayload[]
  onExternalTextConsumed?: () => void
  cwd?: string | null
  slashCommands?: string[]
  commandDescriptions?: Record<string, string>
  commandAvailability?: "runtime" | "preview" | "stale"
  planMode?: boolean
  onPlanModeChange?: (enabled: boolean) => void
  permissionMode?: AppSettings["defaultPermissionMode"]
  onPermissionModeChange?: (mode: AppSettings["defaultPermissionMode"]) => void
  gitStatus?: GitWorktreeStatus | null
  onGitStatusRefresh?: () => void | Promise<void>
  onOpenPlugins?: () => void
  collaborationMode?: boolean
  onCollaborationModeChange?: (enabled: boolean) => void
  oauthUsage?: OauthUsage | null
  model?: string
  effort?: string
  onModelEffortChange?: (next: { model?: string; effort?: string }) => void
  modelOptions?: Array<{ value: string; label?: string }>
  restrictModelOptions?: boolean
  availableEffortLevels?: string[]
  openaiCompatibleProvider?: boolean
  globalDefault?: ComposerPrefs
  sessionPrefs?: ComposerPrefs | null
}

const MAX_TEXT_FILE_BYTES = 1024 * 1024
type Thumb = ComposerDraftImage
type DocumentThumb = ComposerDraftDocument
type FileAttachment = ComposerDraftFileAttachment

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function readAsDataUrlPayload(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const result = reader.result as string
      const idx = result.indexOf("base64,")
      resolve(idx >= 0 ? result.slice(idx + 7) : result)
    }
    reader.readAsDataURL(file)
  })
}

function readAsTextPayload(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.readAsText(file)
  })
}

function readAsArrayBufferPayload(file: File) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(file)
  })
}

function escapeAttr(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function buildOutgoingText(text: string, files: FileAttachment[]) {
  const parts = [text.trim()].filter(Boolean)
  for (const file of files) {
    const mime = file.mime || "application/octet-stream"
    const contentAttr =
      file.contentMode === "inline" ? "" : ` content="${file.contentMode}"`
    const body =
      file.contentMode === "metadata-only"
        ? "[binary file content not included]"
        : file.contentMode === "document"
          ? "[pdf document attached separately]"
          : (file.text ?? "")
    parts.push(
      [
        `<uploaded_file name="${escapeAttr(file.name)}" mime="${escapeAttr(mime)}" size="${file.size}"${contentAttr}>`,
        body,
        "</uploaded_file>"
      ].join("\n")
    )
  }
  return parts.join("\n\n")
}

export function Composer({
  onBeforeSend,
  onSend,
  onStop,
  onRecallQueued,
  streaming,
  interrupting = false,
  disabled,
  centered,
  draftKey,
  initialDraft,
  onDraftChange,
  externalText,
  externalImages,
  externalDocuments,
  onExternalTextConsumed,
  cwd,
  slashCommands,
  commandDescriptions,
  commandAvailability = "preview",
  planMode = false,
  onPlanModeChange,
  permissionMode = "default",
  onPermissionModeChange,
  gitStatus,
  onGitStatusRefresh,
  onOpenPlugins,
  collaborationMode = false,
  onCollaborationModeChange,
  oauthUsage,
  model = "",
  effort = "",
  onModelEffortChange,
  modelOptions,
  restrictModelOptions = false,
  availableEffortLevels,
  openaiCompatibleProvider = false,
  globalDefault,
  sessionPrefs
}: Props) {
  const revisionRef = useRef(0)
  const currentDraftKeyRef = useRef(draftKey)
  currentDraftKeyRef.current = draftKey
  const attachmentGenerationRef = useRef(0)
  const pendingAttachmentsRef = useRef(0)
  const [pendingAttachments, setPendingAttachments] = useState(0)
  const [text, updateText] = useState("")
  const setText = useCallback((value: React.SetStateAction<string>) => {
    revisionRef.current += 1
    updateText(value)
  }, [])
  const [images, updateImages] = useState<Thumb[]>([])
  const setImages = useCallback((value: React.SetStateAction<Thumb[]>) => {
    revisionRef.current += 1
    updateImages(value)
  }, [])
  const [documents, updateDocuments] = useState<DocumentThumb[]>([])
  const setDocuments = useCallback((value: React.SetStateAction<DocumentThumb[]>) => {
    revisionRef.current += 1
    updateDocuments(value)
  }, [])
  const [fileAttachments, updateFileAttachments] = useState<FileAttachment[]>([])
  const setFileAttachments = useCallback((value: React.SetStateAction<FileAttachment[]>) => {
    revisionRef.current += 1
    updateFileAttachments(value)
  }, [])
  const [dragOver, setDragOver] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false)
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const initialDraftRef = useRef<ComposerDraft | undefined>(initialDraft)
  const skipNextDraftReportRef = useRef(true)
  const [trigger, setTrigger] = useState<TriggerInfo | null>(null)
  const [items, setItems] = useState<SuggestionItem[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const fileReqRef = useRef(0)
  /** 上一次刷新候选时的触发签名；null 表示面板处于关闭态 */
  const lastTriggerSigRef = useRef<string | null>(null)
  /**
   * 命中已知命令时，命令 token（连同其后一个空白）折叠成行内 chip，
   * textarea 只编辑其后的正文；text 仍是完整原文，草稿与发送不受影响。
   */
  const commandPrefix = useMemo(
    () => composerCommandPrefix(text, slashCommands ?? []),
    [text, slashCommands]
  )
  const commandToken = commandPrefix.trimEnd()
  const visibleText = text.slice(commandPrefix.length)
  const commandChipRef = useRef<HTMLSpanElement>(null)
  const [commandChipWidth, setCommandChipWidth] = useState(0)
  useLayoutEffect(() => {
    const el = commandChipRef.current
    if (!el) {
      setCommandChipWidth(0)
      return
    }
    const update = () => setCommandChipWidth(el.offsetWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [commandToken])
  /**
   * onKeyDown 已消费的菜单导航键（↑↓/Tab/Enter/Esc）。对应 keyup 到来时
   * 跳过 updateTrigger：否则 refreshSuggestions 会把高亮重置回第 0 项
   * （↑↓ 无法移动选中项的根因），Esc 刚关掉/Enter 刚选完的面板也会被
   * keyup 重新解析触发词而立即重新打开。
   *
   * 用 Set 而非单值：交错按键（按住 ↓ 时按 Esc/Enter，A down → B down →
   * A up → B up）会有多个已消费键同时在途，单值会被后按的键覆盖，先释放
   * 键的 keyup 便漏进 updateTrigger，把刚关掉的面板立即重新打开。长按
   * 重复（多次 keydown 一次 keyup）add 幂等，行为与单值一致；keyup 丢失
   * 的场景（焦点离开）必然先经过 onBlur，在那里整体清空，无残留吞键。
   */
  const menuKeyHandledRef = useRef<Set<string>>(new Set())

  const closeSuggestions = useCallback(() => {
    setTrigger(null)
    setItems([])
    lastTriggerSigRef.current = null
  }, [])

  const refreshSuggestions = useCallback(
    async (info: TriggerInfo) => {
      // 仅当触发签名（kind+start+query）变化时把高亮重置回第 0 项：
      // 同签名的重复刷新（keyup 重新评估、异步文件补全返回）保留用户
      // 用 ↑↓ 选中的位置，只在列表变短时夹紧防止越界。
      const sig = triggerSignature(info)
      const resetActive = lastTriggerSigRef.current !== sig
      lastTriggerSigRef.current = sig
      const applyActiveIdx = (length: number) =>
        setActiveIdx((cur) =>
          resetActive ? 0 : Math.min(cur, Math.max(0, length - 1))
        )
      if (info.kind === "/") {
        const all = (slashCommands ?? []).filter((c) => c)
        const pinned = new Set(loadSettings().pinnedSlash)
        const filtered = info.query
          ? all.filter((c) =>
              c.toLowerCase().includes(info.query.toLowerCase())
            )
          : all
        const pinnedList: SuggestionItem[] = []
        const restList: SuggestionItem[] = []
        for (const c of filtered) {
          if (pinned.has(c)) {
            pinnedList.push({
              key: `pin:${c}`,
              primary: `/${c}`,
              secondary: commandDescriptions?.[c] ?? (["clear", "reset", "permissions"].includes(c) ? "应用内操作" : commandAvailability === "runtime" ? "当前 CLI 会话" : commandAvailability === "stale" ? "缓存预览 · 读取失败" : "本地预览 · 等待 CLI 确认"),
              pinned: true,
              group: "置顶"
            })
          } else {
            restList.push({
              key: c,
              primary: `/${c}`,
              secondary: commandDescriptions?.[c] ?? (["clear", "reset", "permissions"].includes(c) ? "应用内操作" : commandAvailability === "runtime" ? "当前 CLI 会话" : commandAvailability === "stale" ? "缓存预览 · 读取失败" : "本地预览 · 等待 CLI 确认"),
              group: pinnedList.length > 0 ? "全部命令" : undefined
            })
          }
        }
        const merged = [...pinnedList, ...restList].slice(0, 60)
        setItems(merged)
        applyActiveIdx(merged.length)
        return
      }
      // @ 文件补全
      if (!cwd) {
        setItems([])
        return
      }
      const seq = ++fileReqRef.current
      try {
        const matches = await listFiles(cwd, info.query)
        if (seq !== fileReqRef.current) return
        const next = matches.slice(0, 60).map((m) => ({
          key: m.rel,
          primary: m.rel,
          secondary: m.is_dir ? "目录" : undefined
        }))
        setItems(next)
        applyActiveIdx(next.length)
      } catch {
        if (seq === fileReqRef.current) setItems([])
      }
    },
    [cwd, slashCommands, commandDescriptions, commandAvailability]
  )

  const updateTrigger = useCallback(
    (next: string, caret: number) => {
      const t = parseTrigger(next, caret)
      if (t) {
        setTrigger(t)
        void refreshSuggestions(t)
      } else {
        closeSuggestions()
      }
    },
    [closeSuggestions, refreshSuggestions]
  )

  const applySuggestion = useCallback(
    (idx: number) => {
      if (!trigger) return
      const it = items[idx]
      if (!it) return
      const insert = trigger.kind === "/" ? it.primary : `@${it.primary}`
      // trigger 与 caret 都是 textarea（去掉命令前缀后）的坐标
      const before = visibleText.slice(0, trigger.start)
      const caret = ref.current?.selectionStart ?? trigger.start + 1 + trigger.query.length
      const after = visibleText.slice(caret)
      const next = `${commandPrefix}${before}${insert} ${after}`
      setText(next)
      closeSuggestions()
      // 选中命令后前缀可能新折叠成 chip，光标需换算回新的 textarea 坐标
      const pos =
        commandPrefix.length + before.length + insert.length + 1 -
        composerCommandPrefix(next, slashCommands ?? []).length
      requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        el.setSelectionRange(pos, pos)
        el.focus()
      })
    },
    [trigger, items, visibleText, commandPrefix, slashCommands, closeSuggestions]
  )

  useEffect(() => {
    initialDraftRef.current = initialDraft
  }, [initialDraft])

  useEffect(() => {
    const restored = cloneComposerDraft(
      initialDraftRef.current ?? emptyComposerDraft()
    )
    skipNextDraftReportRef.current = true
    setText(restored.text)
    setImages(restored.images)
    setDocuments(restored.documents)
    setFileAttachments(restored.fileAttachments)
    closeSuggestions()
    setActiveIdx(0)
    setPreviewIdx(null)
    attachmentGenerationRef.current += 1
    pendingAttachmentsRef.current = 0
    setPendingAttachments(0)
    return () => { attachmentGenerationRef.current += 1 }
  }, [draftKey, closeSuggestions])

  useEffect(() => {
    if (skipNextDraftReportRef.current) {
      skipNextDraftReportRef.current = false
      return
    }
    onDraftChange?.({ text, images, documents, fileAttachments })
  }, [fileAttachments, images, documents, onDraftChange, text])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 240) + "px"
  }, [text])

  useEffect(() => {
    const hasText = externalText !== undefined && externalText !== ""
    const hasImages = !!externalImages && externalImages.length > 0
    const hasDocuments = !!externalDocuments && externalDocuments.length > 0
    if (!hasText && !hasImages && !hasDocuments) return
    if (hasText) setText(externalText)
    if (hasImages) {
      setImages(
        externalImages.map((image, index) => ({
          ...image,
          id: makeId(),
          name: `queued-image-${index + 1}`,
          size: Math.ceil((image.data.length * 3) / 4)
        }))
      )
    }
    if (hasDocuments) {
      const restoredDocuments = externalDocuments.map((document) => ({
        ...document,
        id: makeId()
      }))
      setDocuments(restoredDocuments)
      setFileAttachments(
        restoredDocuments.map((document) => ({
          id: document.id,
          name: document.name,
          mime: document.mime,
          size: document.size,
          text: null,
          contentMode: "document"
        }))
      )
    }
    onExternalTextConsumed?.()
    requestAnimationFrame(() => ref.current?.focus())
  }, [externalDocuments, externalImages, externalText, onExternalTextConsumed])

  // 打开 + 菜单时再拉一次已安装插件，避免 GUI 启动时阻塞
  useEffect(() => {
    if (!plusOpen) return
    listInstalledPlugins()
      .then(setInstalledPlugins)
      .catch(() => setInstalledPlugins([]))
  }, [plusOpen])

  const preparingSendRef = useRef(false)
  const [preparingSend, setPreparingSend] = useState(false)

  const send = async (mode?: "guide" | "followup") => {
    if (preparingSendRef.current || disabled) return
    if (pendingAttachmentsRef.current > 0) {
      toast.info("附件仍在读取，请稍后发送")
      return
    }
    const submitted = { key: draftKey, revision: revisionRef.current }
    const outgoingText = buildOutgoingText(text, fileAttachments)
    if (!outgoingText.trim() && images.length === 0 && documents.length === 0) return
    const outgoingImages = images.map((i) => ({ data: i.data, mime: i.mime, order: i.order }))
    const outgoingDocuments = documents.map(({ data, mime, name, size, order }) => ({ data, mime, name, size, order }))
    preparingSendRef.current = true
    setPreparingSend(true)
    try {
      const canContinue = (await onBeforeSend?.(outgoingText, outgoingImages, outgoingDocuments)) ?? true
      if (!canContinue || currentDraftKeyRef.current !== submitted.key) return
      const outcome = await onSend(outgoingText, outgoingImages, outgoingDocuments, mode ? { mode } : undefined)
      if (!canClearSubmittedDraft(submitted, { key: currentDraftKeyRef.current, revision: revisionRef.current }, outcome)) return
      setText("")
      setImages([])
      setDocuments([])
      setFileAttachments([])
      if (collaborationMode) onCollaborationModeChange?.(false)
    } catch (error) {
      toast.error(`未完成发送，内容已保留：${String(error)}`)
    } finally {
      preparingSendRef.current = false
      setPreparingSend(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 快捷键优先级（高 → 低）：Alt 组合键（streaming 专用）→ slash token
    // 删除 → 候选菜单 → Enter 发送/排队 → Esc 软中断。
    //
    // Alt+↑ 故意排在菜单导航之前：菜单导航分支均要求 !e.altKey，按键空间
    // 与 Alt 组合键不重叠——菜单打开时 Alt+↑ 仍执行「撤回排队」，普通 ↑↓
    // 始终归菜单导航（审计结论 #3，见任务 research/keymap.md）。
    if (
      e.key === "ArrowUp" &&
      e.altKey &&
      streaming &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault()
      onRecallQueued?.()
      return
    }
    if (
      e.key === "Enter" &&
      e.altKey &&
      !e.shiftKey &&
      streaming &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault()
      send("followup")
      return
    }
    // Ctrl/⌘+Enter：运行中立即引导（即时送达当前回合）
    if (
      e.key === "Enter" &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      streaming &&
      !interrupting &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault()
      send("guide")
      return
    }
    if (
      e.key === "Backspace" &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.nativeEvent.isComposing
    ) {
      // 光标在正文最前（紧贴 chip）时 Backspace 整体删除命令
      const el = e.currentTarget
      if (commandPrefix && el.selectionStart === 0 && el.selectionEnd === 0) {
        e.preventDefault()
        menuKeyHandledRef.current.add(e.key)
        setText(visibleText)
        closeSuggestions()
        requestAnimationFrame(() => ref.current?.setSelectionRange(0, 0))
        return
      }
    }
    if (trigger) {
      // IME 组合期间 ↑↓/Tab/Enter 属于输入法候选操作，不得当作菜单导航
      // 或选中命令（与下方发送分支同款守卫）；Escape 关面板无副作用，
      // 不需要守卫。
      const composing = e.nativeEvent.isComposing
      if (items.length > 0 && !composing) {
        if (e.key === "ArrowDown" && !e.altKey) {
          e.preventDefault()
          menuKeyHandledRef.current.add(e.key)
          setActiveIdx((i) => (i + 1) % items.length)
          return
        }
        if (e.key === "ArrowUp" && !e.altKey) {
          e.preventDefault()
          menuKeyHandledRef.current.add(e.key)
          setActiveIdx((i) => (i - 1 + items.length) % items.length)
          return
        }
        if (
          e.key === "Tab" ||
          (e.key === "Enter" &&
            !e.shiftKey &&
            !e.altKey &&
            !e.ctrlKey &&
            !e.metaKey)
        ) {
          e.preventDefault()
          menuKeyHandledRef.current.add(e.key)
          applySuggestion(activeIdx)
          return
        }
      }
      // 防回归（审计结论 #2）：面板打开时 Esc 永远先关面板并 return，
      // 不落入下方 streaming 软中断分支；再按一次 Esc 才会中断。
      // 该分支必须保持在软中断之前，且不能要求 items.length > 0——
      // 空结果提示（"无匹配命令/文件"）同样是打开状态，Esc 应当关掉它
      // 而不是误触软中断。
      if (e.key === "Escape") {
        e.preventDefault()
        menuKeyHandledRef.current.add(e.key)
        closeSuggestions()
        return
      }
    }
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault()
      send(streaming ? "followup" : undefined)
    } else if (e.key === "Escape" && streaming) {
      e.preventDefault()
      onStop()
    }
  }

  const handleFiles = async (files: FileList | File[]) => {
    const generation = attachmentGenerationRef.current
    const ownerKey = draftKey
    pendingAttachmentsRef.current += 1
    setPendingAttachments(pendingAttachmentsRef.current)
    const nextImages: Thumb[] = []
    const nextDocuments: DocumentThumb[] = []
    const nextFileAttachments: FileAttachment[] = []
    let skipped = 0
    const skippedDetails: string[] = []

    const batchOrder = Date.now()
    let batchIndex = 0
    for (const file of Array.from(files)) {
      const order = batchOrder + batchIndex++ / 1000
      try {
        if (generation !== attachmentGenerationRef.current || ownerKey !== currentDraftKeyRef.current) break
        if (file.size > 20 * 1024 * 1024) throw new Error("单个附件不能超过 20 MB")
        if (isLegacyWordDocFile(file)) {
          skipped += 1
          skippedDetails.push(
            `${file.name || "document.doc"} 是旧版 .doc 格式，请另存为 .docx 或 PDF 后上传`
          )
          continue
        }

        if (!isSupportedUploadFile(file)) {
          skipped += 1
          skippedDetails.push(
            `${file.name || "文件"} 类型不支持；仅支持图片、PDF、DOCX 和文本文件`
          )
          continue
        }

        const imageMime = supportedImageMime(file)
        if (imageMime) {
          const data = await readAsDataUrlPayload(file)
          nextImages.push({
            order,
            id: makeId(),
            data,
            mime: imageMime,
            name: file.name || "image",
            size: file.size
          })
          continue
        }

        if (isPdfFile(file)) {
          const id = makeId()
          const data = await readAsDataUrlPayload(file)
          const name = file.name || "document.pdf"
          const mime = "application/pdf"
          nextDocuments.push({
            order,
            id,
            data,
            mime,
            name,
            size: file.size
          })
          nextFileAttachments.push({
            id,
            name,
            mime,
            size: file.size,
            text: null,
            contentMode: "document"
          })
          continue
        }

        if (isDocxFile(file)) {
          const body = await extractDocxText(await readAsArrayBufferPayload(file))
          if (!body.trim()) {
            throw new Error("Word 文档中没有可提取的文本")
          }
          nextFileAttachments.push({
            id: makeId(),
            name: file.name || "document.docx",
            mime:
              file.type ||
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size: file.size,
            text: body,
            contentMode: "inline"
          })
          continue
        }

        if (file.size > MAX_TEXT_FILE_BYTES) {
          skipped += 1
          skippedDetails.push(
            `${file.name || "文本文件"} 超过 ${formatBytes(MAX_TEXT_FILE_BYTES)}`
          )
          continue
        }

        const body = await readAsTextPayload(file)
        nextFileAttachments.push({
          id: makeId(),
          name: file.name || "file.txt",
          mime: file.type || "text/plain",
          size: file.size,
          text: body,
          contentMode: "inline"
        })
      } catch (error) {
        skipped += 1
        skippedDetails.push(`${file.name || "文件"}：${String(error)}`)
      }
    }

    if (generation !== attachmentGenerationRef.current || ownerKey !== currentDraftKeyRef.current) return
    pendingAttachmentsRef.current -= 1
    setPendingAttachments(pendingAttachmentsRef.current)
    if (nextImages.length) setImages((cur) => [...cur, ...nextImages])
    if (nextDocuments.length) {
      setDocuments((cur) => [...cur, ...nextDocuments])
    }
    if (nextFileAttachments.length) {
      setFileAttachments((cur) => [...cur, ...nextFileAttachments])
    }
    if (skipped > 0) {
      toast.warning(
        skippedDetails.length > 0
          ? `已跳过 ${skipped} 个文件：${skippedDetails.slice(0, 2).join("；")}`
          : `已跳过 ${skipped} 个文件`
      )
    }
  }

  const attachPastedText = (body: string) => {
    const size = utf8ByteLength(body)
    if (size > MAX_TEXT_FILE_BYTES) {
      toast.warning(
        `粘贴文本超过 ${formatBytes(MAX_TEXT_FILE_BYTES)}，未添加附件`
      )
      return
    }
    setFileAttachments((cur) => [
      ...cur,
      {
        id: makeId(),
        name: pastedTextFileName(),
        mime: "text/plain",
        size,
        text: body,
        contentMode: "inline"
      }
    ])
    closeSuggestions()
    toast.success("已将长文本作为 txt 附件添加")
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = e.clipboardData
    if (!clipboard) return
    const items = clipboard.items
    const files: File[] = []
    for (const it of Array.from(items)) {
      if (it.kind === "file") {
        const f = it.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length) {
      e.preventDefault()
      void handleFiles(files)
      return
    }
    const pastedText = clipboard.getData("text/plain")
    if (shouldAttachPastedText(pastedText)) {
      e.preventDefault()
      attachPastedText(pastedText)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (files && files.length) handleFiles(files)
  }

  const canSend =
    !!text.trim() || images.length > 0 || fileAttachments.length > 0
  const sendBlocked =
    disabled || preparingSend || pendingAttachments > 0 || !canSend

  return (
    <div
      className={cn(
        "shrink-0 transition-colors",
        centered ? "w-full" : "bg-background px-6 pb-4 pt-2"
      )}
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
    >
      <div
        className={cn(
          "relative",
          !centered &&
            "mx-auto w-full max-w-3xl xl:max-w-4xl 2xl:max-w-5xl"
        )}
      >
        <SuggestionPanel
          open={!!trigger}
          items={items}
          activeIdx={activeIdx}
          onPick={applySuggestion}
          onHover={setActiveIdx}
          emptyHint={
            trigger?.kind === "/" ? "无匹配命令" : "无匹配文件"
          }
        />
        <div
          className={cn(
            "rounded-[14px] border bg-card p-3 shadow-sm transition-colors",
            dragOver && "bg-accent/40 ring-2 ring-inset ring-ring/50"
          )}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={SUPPORTED_ATTACHMENT_ACCEPT}
            className="sr-only"
            onChange={(e) => {
              const files = e.currentTarget.files
              if (files?.length) handleFiles(files)
              e.currentTarget.value = ""
            }}
          />

          {(images.length > 0 ||
            fileAttachments.length > 0 ||
            collaborationMode) && (
            <div className="mb-2 flex flex-wrap gap-2">
              {collaborationMode && (
                <AttachmentChip
                  icon={<Bot className="size-3.5" />}
                  label="协同模式"
                  meta="本次发送生效"
                  onRemove={() => onCollaborationModeChange?.(false)}
                />
              )}
              {images.map((img, i) => (
                <AttachmentChip
                  key={img.id}
                  icon={<ImageIcon className="size-3.5" />}
                  label={img.name}
                  meta={formatBytes(img.size)}
                  onClick={() => setPreviewIdx(i)}
                  onRemove={() =>
                    setImages((cur) => cur.filter((item) => item.id !== img.id))
                  }
                />
              ))}
              {fileAttachments.map((file) => (
                <AttachmentChip
                  key={file.id}
                  icon={<FileText className="size-3.5" />}
                  label={file.name}
                  meta={
                    file.contentMode === "metadata-only"
                      ? `${formatBytes(file.size)} · 仅信息`
                      : file.contentMode === "document"
                        ? `${formatBytes(file.size)} · PDF`
                        : formatBytes(file.size)
                  }
                  onRemove={() => {
                    setFileAttachments((cur) =>
                      cur.filter((item) => item.id !== file.id)
                    )
                    setDocuments((cur) =>
                      cur.filter((item) => item.id !== file.id)
                    )
                  }}
                />
              ))}
            </div>
          )}

          <div className="relative overflow-hidden">
            {commandToken && (
              // 与 textarea 首行对齐：py-1(4px) + (行高 26px - chip 22px) / 2
              <CommandChip
                ref={commandChipRef}
                command={commandToken}
                className={cn(
                  "pointer-events-none absolute left-1 top-[6px] z-10 max-w-[60%]",
                  disabled && "opacity-50"
                )}
              />
            )}
            <Textarea
              ref={ref}
              value={visibleText}
              aria-label={commandToken ? `${commandToken} 的补充说明` : undefined}
              style={
                commandToken && commandChipWidth
                  ? { textIndent: commandChipWidth + 6 }
                  : undefined
              }
              onScroll={(e) => {
                const chip = commandChipRef.current
                if (chip) chip.style.transform = `translateY(${-e.currentTarget.scrollTop}px)`
              }}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
                const v = e.target.value
                setText(commandPrefix + v)
                const caret = e.target.selectionStart ?? v.length
                updateTrigger(v, caret)
              }}
              onKeyUp={(e) => {
                // onKeyUp 的职责：跟踪 ←→/Home/End 等纯光标移动进出触发词
                //（这些键不触发 onChange）。onKeyDown 已消费的菜单键到达
                // keyup 时直接吞掉，不重新评估触发词（见 menuKeyHandledRef）。
                if (menuKeyHandledRef.current.delete(e.key)) return
                const el = e.currentTarget
                updateTrigger(el.value, el.selectionStart ?? 0)
              }}
              onClick={(e) => {
                const el = e.currentTarget
                updateTrigger(el.value, el.selectionStart ?? 0)
              }}
              onBlur={() => {
                menuKeyHandledRef.current.clear()
                // 延迟关闭：让点击 SuggestionPanel 项的 onClick 先触发
                setTimeout(() => closeSuggestions(), 100)
              }}
              onKeyDown={onKey}
              onPaste={onPaste}
              placeholder={
                commandToken
                  ? "补充说明，或直接发送"
                  : streaming
                    ? "补充要求，完成后发送"
                    : "输入消息，或用 / 选择命令"
              }
              disabled={disabled}
              rows={1}
              className={cn(
                "min-h-[56px] max-h-60 border-0 bg-transparent px-1 py-1 text-base shadow-none focus-visible:ring-0 [scrollbar-gutter:stable]",
                "font-sans font-normal leading-relaxed text-foreground"
              )}
            />
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1">
            <DropdownMenu open={plusOpen} onOpenChange={setPlusOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label="添加附件和插件"
                  title="添加附件和插件"
                  className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <Plus className="size-5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                side="top"
                className="w-48 rounded-2xl p-1.5"
              >
                <DropdownMenuItem
                  className="h-10 rounded-xl"
                  onSelect={() => inputRef.current?.click()}
                >
                  <Paperclip className="size-4" />
                  <span>添加照片和文件</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="h-10 rounded-xl"
                  onSelect={() => {
                    onCollaborationModeChange?.(!collaborationMode)
                    setPlusOpen(false)
                  }}
                >
                  <Bot className="size-4" />
                  <span className="flex-1">协同</span>
                  {collaborationMode && <Check className="size-4" />}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="h-10 rounded-xl"
                  onSelect={(e) => {
                    e.preventDefault()
                    onPlanModeChange?.(!planMode)
                  }}
                >
                  <ListTodo className="size-4" />
                  <span className="flex-1">计划模式</span>
                  <span
                    aria-hidden
                    className={cn(
                      "inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors",
                      planMode ? "bg-primary" : "bg-input"
                    )}
                  >
                    <span
                      className={cn(
                        "block size-4 rounded-full bg-background shadow-sm transition-transform",
                        planMode ? "translate-x-4" : "translate-x-0"
                      )}
                    />
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="h-10 rounded-xl">
                    <Blocks className="size-4" />
                    <span className="flex-1">插件</span>
                    {installedPlugins.length > 0 && (
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {installedPlugins.length}
                      </span>
                    )}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent
                    className="w-60 rounded-xl p-1"
                    sideOffset={6}
                  >
                    <div className="px-2 py-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                      {installedPlugins.length > 0
                        ? `${installedPlugins.length} 个已安装插件`
                        : "未安装插件"}
                    </div>
                    {installedPlugins.length === 0 ? (
                      <div className="px-2 py-1 text-xs text-muted-foreground">
                        点击「管理插件」浏览 Marketplace
                      </div>
                    ) : (
                      <div className="max-h-72 overflow-y-auto">
                        {installedPlugins.map((p) => (
                          <DropdownMenuItem
                            key={`${p.id}-${p.scope}-${p.project_path ?? ""}`}
                            className="h-9 rounded-lg"
                            onSelect={(e) => {
                              e.preventDefault()
                              onOpenPlugins?.()
                            }}
                          >
                            <Package className="size-4 text-muted-foreground" />
                            <span className="flex-1 truncate">{p.name}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {p.scope === "user"
                                ? ""
                                : p.scope === "project"
                                  ? "项目"
                                  : "本地"}
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </div>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="h-9 rounded-lg"
                      onSelect={() => onOpenPlugins?.()}
                    >
                      <SettingsIcon className="size-4" />
                      <span>管理插件</span>
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
            <PermissionModePicker
              mode={permissionMode}
              onChange={onPermissionModeChange}
              disabled={disabled}
            />
            <GitBranchPicker
              cwd={cwd}
              status={gitStatus ?? null}
              disabled={disabled}
              onChanged={onGitStatusRefresh}
            />
            </div>

            <div className="flex items-center gap-1">
              {onModelEffortChange && (
                <ModelEffortPicker
                  model={model}
                  effort={effort}
                  onChange={onModelEffortChange}
                  modelOptions={modelOptions}
                  restrictModelOptions={restrictModelOptions}
                  availableEffortLevels={availableEffortLevels}
                  openaiCompatibleProvider={openaiCompatibleProvider}
                  disabled={disabled}
                  globalDefault={globalDefault}
                  sessionPrefs={sessionPrefs}
                />
              )}
              <PlanUsageIndicator usage={oauthUsage ?? null} />
              {streaming ? (
                // 运行中两种投递方式并排成一组：引导即时送达，排队等本轮结束
                <div
                  role="group"
                  aria-label="运行中发送方式"
                  className="flex h-8 items-center rounded-lg border bg-background shadow-sm"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={sendBlocked || interrupting}
                    onClick={() => void send("guide")}
                    aria-label="立即引导"
                    title="立即引导：马上送达，模型在当前回合内参考 (Ctrl+Enter)"
                    className="h-full gap-1 rounded-r-none px-2.5 text-xs"
                  >
                    <CornerDownRight className="size-3.5" />
                    引导
                  </Button>
                  <span className="h-4 w-px bg-border" aria-hidden />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={sendBlocked}
                    onClick={() => void send("followup")}
                    aria-label="排入后续消息"
                    title="排队：当前回合全部完成后送达 (Enter)"
                    className="h-full gap-1 rounded-l-none px-2.5 text-xs"
                  >
                    {preparingSend ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ListPlus className="size-3.5" />
                    )}
                    排队
                  </Button>
                </div>
              ) : (
                <Button
                  onClick={() => void send()}
                  disabled={sendBlocked}
                  size="icon"
                  aria-label="发送"
                  title="发送 (Enter)"
                  className="size-8 rounded-lg shadow-sm"
                >
                  {preparingSend ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </Button>
              )}
              {streaming && (
                <Button
                  onClick={() => onStop()}
                  variant="outline"
                  size="icon"
                  disabled={disabled || interrupting}
                  aria-label="中断当前回合"
                  title={interrupting ? "正在中断…" : "中断当前回合 (Esc)"}
                  className="size-8 rounded-lg text-foreground/70 shadow-sm hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                >
                  {interrupting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Square fill="currentColor" className="size-2.5" />
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
      {previewIdx !== null && images[previewIdx] && (
        <ImageLightbox
          open
          src={`data:${images[previewIdx].mime};base64,${images[previewIdx].data}`}
          alt={images[previewIdx].name || `待发送图片 ${previewIdx + 1}`}
          onClose={() => setPreviewIdx(null)}
        />
      )}
    </div>
  )
}

function AttachmentChip({
  icon,
  label,
  meta,
  onClick,
  onRemove
}: {
  icon: ReactNode
  label: string
  meta: string
  onClick?: () => void
  onRemove: () => void
}) {
  const body = (
    <>
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-background text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block max-w-40 truncate text-xs font-medium">
          {label}
        </span>
        <span className="block text-[10px] leading-none text-muted-foreground">
          {meta}
        </span>
      </span>
    </>
  )

  return (
    <span className="group/chip inline-flex max-w-full items-center gap-2 rounded-full border bg-muted/60 py-1 pl-1 pr-1.5">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="inline-flex min-w-0 items-center gap-2 rounded-full text-left"
          title={label}
        >
          {body}
        </button>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-2" title={label}>
          {body}
        </span>
      )}
      <button
        type="button"
        aria-label={`移除 ${label}`}
        onClick={onRemove}
        className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

const PERMISSION_OPTIONS: Array<{
  value: AppSettings["defaultPermissionMode"]
  label: string
  description: string
}> = [
  {
    value: "default",
    label: "默认权限",
    description: "使用 Claude CLI 默认权限策略"
  },
  {
    value: "acceptEdits",
    label: "接受编辑",
    description: "允许文件编辑，仍保留其它权限请求"
  },
  {
    value: "plan",
    label: "计划模式",
    description: "只规划，不直接执行修改"
  },
  {
    value: "bypassPermissions",
    label: "跳过权限",
    description: "仅在可信工作区使用"
  }
]

// 菜单可选项不含 plan：计划模式入口收敛到「+」菜单的开关。
// PERMISSION_OPTIONS 保留全集，供 mode === "plan" 的旧会话（sidecar/设置残留）
// 在 chip 上仍正确显示「计划模式」标签。
const SELECTABLE_PERMISSION_OPTIONS = PERMISSION_OPTIONS.filter(
  (item) => item.value !== "plan"
)

function PermissionModePicker({
  mode,
  onChange,
  disabled
}: {
  mode: AppSettings["defaultPermissionMode"]
  onChange?: (mode: AppSettings["defaultPermissionMode"]) => void
  disabled?: boolean
}) {
  const current =
    PERMISSION_OPTIONS.find((item) => item.value === mode) ??
    PERMISSION_OPTIONS[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled || !onChange}
          className={cn(
            "inline-flex h-7 max-w-[128px] items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          )}
          title="会话权限模式，下一次启动 Claude CLI 会话时生效"
        >
          <ShieldCheck className="size-3.5" />
          <span className="truncate">{current.label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56 rounded-xl p-1.5">
        <DropdownMenuLabel>会话权限</DropdownMenuLabel>
        {SELECTABLE_PERMISSION_OPTIONS.map((item) => (
          <DropdownMenuItem
            key={item.value}
            className="rounded-lg"
            onSelect={() => onChange?.(item.value)}
          >
            <span className="grid size-4 place-items-center">
              {item.value === mode && <Check className="size-3.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{item.label}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {item.description}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function GitBranchPicker({
  cwd,
  status,
  disabled,
  onChanged
}: {
  cwd?: string | null
  status: GitWorktreeStatus | null
  disabled?: boolean
  onChanged?: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [newBranch, setNewBranch] = useState("")
  const [branches, setBranches] = useState<GitBranchList | null>(null)
  const [localStatus, setLocalStatus] = useState<GitWorktreeStatus | null>(status)
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState(false)
  const effectiveStatus = localStatus ?? status
  const current = branches?.current ?? effectiveStatus?.branch ?? null

  useEffect(() => {
    setLocalStatus(status)
  }, [status])

  useEffect(() => {
    if (!open || !cwd || !status?.isRepo) return
    let cancelled = false
    setLoading(true)
    Promise.all([gitBranchList(cwd), gitWorktreeStatus(cwd)])
      .then(([list, nextStatus]) => {
        if (cancelled) return
        setBranches(list)
        setLocalStatus(nextStatus)
        void onChanged?.()
      })
      .catch((e) => {
        if (!cancelled) {
          setBranches(null)
          toast.error(`读取 Git 状态失败: ${String(e)}`)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, cwd, status?.isRepo, onChanged])

  if (!effectiveStatus?.isRepo || !current || !cwd) return null

  const filtered = (branches?.branches ?? [])
    .filter((branch) =>
      query.trim()
        ? branch.name.toLowerCase().includes(query.trim().toLowerCase())
        : true
    )
    .slice(0, 80)

  const checkout = async (branch: string, create = false) => {
    if (!cwd || switching) return
    const target = branch.trim()
    if (!target) return
    setSwitching(true)
    try {
      await gitCheckoutBranch({ cwd, branch: target, create })
      const [list, nextStatus] = await Promise.all([
        gitBranchList(cwd),
        gitWorktreeStatus(cwd)
      ])
      setBranches(list)
      setLocalStatus(nextStatus)
      toast.success(create ? `已创建并切换到 ${target}` : `已切换到 ${target}`)
      setOpen(false)
      setNewBranch("")
      setQuery("")
      await onChanged?.()
    } catch (e) {
      toast.error(`切换分支失败: ${String(e)}`)
    } finally {
      setSwitching(false)
    }
  }

  const dirtySummary =
    effectiveStatus.changedFiles > 0
      ? `未提交：${effectiveStatus.changedFiles} 个文件`
      : "工作区干净"

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "hidden sm:inline-flex h-7 max-w-[150px] items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          )}
          title={`${current} · ${dirtySummary}`}
        >
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate font-mono">{current}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-72 rounded-2xl p-0"
      >
        <div className="border-b p-2">
          <div className="flex h-8 items-center gap-2 rounded-lg px-2 text-muted-foreground">
            <Search className="size-3.5" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="搜索分支"
              className="h-7 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
            />
          </div>
        </div>
        <DropdownMenuLabel className="px-3 pt-2 text-xs text-muted-foreground">
          分支
        </DropdownMenuLabel>
        <div className="max-h-64 overflow-y-auto p-1">
          {loading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              正在读取分支…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              没有匹配分支
            </div>
          ) : (
            filtered.map((branch) => (
              <DropdownMenuItem
                key={branch.name}
                className="min-h-10 rounded-lg"
                disabled={switching || branch.name === current}
                onSelect={() => void checkout(branch.name)}
              >
                <GitBranch className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-sm">
                    {branch.name}
                  </span>
                  {branch.name === current && effectiveStatus.changedFiles > 0 && (
                    <span className="block text-[11px] text-muted-foreground">
                      {dirtySummary}
                    </span>
                  )}
                </span>
                {branch.name === current && <Check className="size-4" />}
              </DropdownMenuItem>
            ))
          )}
        </div>
        <DropdownMenuSeparator />
        <div className="flex items-center gap-2 p-2">
          <Input
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              // isComposing：CJK 输入法确认候选字的 Enter 不创建分支
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void checkout(newBranch, true)
              }
            }}
            placeholder="新分支名"
            className="h-8 text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={switching || !newBranch.trim()}
            onClick={() => void checkout(newBranch, true)}
            className="shrink-0"
          >
            <Plus className="size-3.5" />
            创建
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PlanUsageIndicator({ usage }: { usage: OauthUsage | null }) {
  // 仅 Anthropic OAuth 登录用户能拿到 plan usage；第三方 API / 未登录返回 null。
  // 该控件的存在本身="官方账号已登录"。
  if (!usage) return null
  const percent = fiveHourPercent(usage)
  if (percent === null) return null

  const fiveHour = usage.five_hour
  const sevenDay = usage.seven_day
  const sevenDayOpus = usage.seven_day_opus ?? undefined
  const sevenDaySonnet = usage.seven_day_sonnet ?? undefined

  const fmtReset = (resetsAt: string | undefined) => {
    const t = shortResets(resetsAt)
    if (!t) return ""
    return t === "已重置" ? "已重置" : `${t}后重置`
  }

  const ringStyle = {
    background: `conic-gradient(var(--primary) ${percent}%, var(--border) 0)`
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-full transition-opacity hover:opacity-80"
          aria-label={`Plan ${percent}%`}
        >
          <span
            className="grid size-4 place-items-center rounded-full"
            style={ringStyle}
          >
            <span className="block size-2.5 rounded-full bg-card" />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="w-72 max-w-[calc(100vw-24px)] rounded-xl px-4 py-3"
      >
        <div className="space-y-2 text-left">
          <div className="text-xs font-medium text-muted-foreground">
            计划用量
          </div>
          {fiveHour && (
            <UsageRow
              label="5 小时限额"
              window={fiveHour}
              suffix={fmtReset(fiveHour.resets_at)}
            />
          )}
          {sevenDay && (
            <UsageRow
              label="每周 · 全部模型"
              window={sevenDay}
              suffix={fmtReset(sevenDay.resets_at)}
            />
          )}
          {sevenDaySonnet && (
            <UsageRow
              label="每周 · Sonnet"
              window={sevenDaySonnet}
              suffix={fmtReset(sevenDaySonnet.resets_at)}
            />
          )}
          {sevenDayOpus && (
            <UsageRow
              label="每周 · 仅 Opus"
              window={sevenDayOpus}
              suffix={fmtReset(sevenDayOpus.resets_at)}
            />
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function UsageRow({
  label,
  window: w,
  suffix
}: {
  label: string
  window: OauthUsageWindow
  suffix?: string
}) {
  const pct = Math.max(0, Math.min(100, Math.round(w.utilization)))
  const tone =
    pct >= 90 ? "bg-destructive" : pct >= 60 ? "bg-warn" : "bg-primary"
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {pct}%{suffix ? ` · ${suffix}` : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full transition-[width]", tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
