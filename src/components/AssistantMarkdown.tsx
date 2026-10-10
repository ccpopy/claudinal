import {
  createContext,
  memo,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react"
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { toast } from "sonner"
import { LocalFileContextMenu, loadAvailableOpenTargets } from "@/components/LocalFileContextMenu"
import { LocalFileIcon } from "@/components/LocalFileIcon"
import { openPath, openPathWith } from "@/lib/ipc"
import { classifyReference, type LocalFileReference } from "@/lib/localPath"
import { remarkReferenceSources } from "@/lib/markdownReferences"
import { loadLocalFileStatus, localFileUnavailableReason } from "@/lib/localFileStatus"
import { cn } from "@/lib/utils"

interface Props {
  text: string
  partial?: boolean
  cwd?: string | null
  commands?: readonly string[]
  variant?: "default" | "activity"
}

const MarkdownReferenceContext = createContext<{ cwd: string | null; commands?: readonly string[] }>({ cwd: null })
export const MarkdownCommandsContext = createContext<readonly string[] | undefined>(undefined)

function LocalReferenceButton({ reference, children, className }: { reference: LocalFileReference; children: React.ReactNode; className?: string }) {
  const [issue, setIssue] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const open = async () => {
    if (opening) return
    setOpening(true)
    try {
      const info = await loadLocalFileStatus(reference)
      const reason = localFileUnavailableReason(info)
      if (reason) {
        setIssue(reason)
        return
      }
      setIssue(null)
      if (reference.line && info.kind === "file") {
        const targets = await loadAvailableOpenTargets()
        if (targets.includes("vscode")) {
          await openPathWith(info.path, "vscode", reference)
          return
        }
      }
      const result = await openPath(info.path)
      if (result.action === "revealed_parent") toast.warning("文件未能直接打开，已打开所在目录")
    } catch (error) {
      setIssue(`打开失败：${String(error)}`)
    } finally {
      setOpening(false)
    }
  }
  return (
    <LocalFileContextMenu reference={reference}>
      <button type="button" className={className} onClick={() => void open()} title={issue ?? (reference.needsConfirmation ? "检查此本地路径；确认存在后打开" : undefined)} aria-busy={opening}>
        {!reference.needsConfirmation && <LocalFileIcon path={reference.path} />}
        <span>{children}</span>
        {issue && <span className="ml-1 text-xs text-muted-foreground" role="status">（{issue}）</span>}
      </button>
    </LocalFileContextMenu>
  )
}

const components: Components = {
  p: ({ node: _node, className, ...props }) => (
    <p
      className={cn(
        "my-2 text-sm leading-normal text-foreground first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  h1: ({ node: _node, className, ...props }) => (
    <h1
      className={cn(
        "mb-2 mt-4 text-xl font-semibold leading-[1.3] text-foreground [font-variation-settings:'opsz'_28]",
        className
      )}
      {...props}
    />
  ),
  h2: ({ node: _node, className, ...props }) => (
    <h2
      className={cn(
        "mb-2 mt-3 text-base font-semibold leading-normal text-foreground",
        className
      )}
      {...props}
    />
  ),
  h3: ({ node: _node, className, ...props }) => (
    <h3
      className={cn(
        "mb-1.5 mt-3 text-sm font-semibold leading-normal text-foreground",
        className
      )}
      {...props}
    />
  ),
  ul: ({ node: _node, className, ...props }) => (
    <ul
      className={cn(
        "my-2 list-disc space-y-1 pl-5 text-sm leading-normal marker:text-muted-foreground",
        className
      )}
      {...props}
    />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol
      className={cn(
        "my-2 list-decimal space-y-1 pl-5 text-sm leading-normal marker:text-muted-foreground",
        className
      )}
      {...props}
    />
  ),
  li: ({ node: _node, className, ...props }) => (
    <li
      className={cn(
        "pl-1 leading-normal [&>ol]:my-1 [&>p]:my-0 [&>ul]:my-1",
        className
      )}
      {...props}
    />
  ),
  a: function MarkdownLink({
    node: _node,
    className,
    href,
    children,
    ...props
  }) {
    const context = useContext(MarkdownReferenceContext)
    const classification = href ? classifyReference(href, { source: "markdown_link", ...context }) : null
    if (classification?.kind === "local") {
      return (
          <LocalReferenceButton
            key={classification.reference.path}
            reference={classification.reference}
            className={cn(
              "inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline",
              className
            )}
          >
            {children}
          </LocalReferenceButton>
      )
    }
    if (classification?.kind === "command" || classification?.kind === "code") return <span className={className}>{children}</span>
    return (
      <a
        className={cn("text-primary underline-offset-4 hover:underline", className)}
        target="_blank"
        rel="noreferrer noopener"
        href={href}
        {...props}
      >
        {children}
      </a>
    )
  },
  blockquote: ({ node: _node, className, ...props }) => (
    <blockquote
      className={cn(
        "my-3 border-l-2 border-border pl-4 text-muted-foreground",
        className
      )}
      {...props}
    />
  ),
  hr: ({ node: _node, className, ...props }) => (
    <hr className={cn("my-4 border-border", className)} {...props} />
  ),
  table: ({ node: _node, className, ...props }) => (
    <div className="my-2 overflow-auto scrollbar-thin">
      <table
        className={cn(
          "w-full text-xs border-collapse border border-border",
          className
        )}
        {...props}
      />
    </div>
  ),
  th: ({ node: _node, className, ...props }) => (
    <th
      className={cn(
        "border border-border bg-muted px-2 py-1 text-left font-semibold",
        className
      )}
      {...props}
    />
  ),
  td: ({ node: _node, className, ...props }) => (
    <td
      className={cn("border border-border px-2 py-1 align-top", className)}
      {...props}
    />
  ),
  code: function MarkdownCode({ node, className, children, ...props }) {
    const context = useContext(MarkdownReferenceContext)
    const isInline = (node?.properties["data-reference-source"] ?? node?.properties.dataReferenceSource) === "inline_code"
    if (isInline) {
      const text = String(children)
      const classification = classifyReference(text, { source: "inline_code", ...context })
      if (classification.kind === "local") {
        return (
            <LocalReferenceButton
              key={classification.reference.path}
              reference={classification.reference}
              className={cn(
                "inline-flex items-center gap-1 rounded-[5px] bg-muted/70 px-1.5 py-0.5 align-baseline font-mono text-[0.86em] leading-normal text-primary underline-offset-4 hover:underline [overflow-wrap:anywhere]",
                className
              )}
            >
              {children}
            </LocalReferenceButton>
        )
      }
      return (
        <code
          className={cn(
            "rounded-[5px] bg-muted/70 px-1.5 py-0.5 align-baseline font-mono text-[0.86em] leading-normal text-foreground/90 [overflow-wrap:anywhere]",
            className
          )}
          {...props}
        >
          {children}
        </code>
      )
    }
    return (
      <code
        className={cn("font-mono text-[12.5px] leading-normal text-foreground/90", className)}
        {...props}
      >
        {children}
      </code>
    )
  },
  pre: ({ node: _node, className, ...props }) => (
    <pre
      className={cn(
        "my-3 overflow-x-auto rounded-lg border bg-muted/55 p-3.5 font-mono text-[12.5px] leading-normal text-foreground/90 scrollbar-thin [tab-size:2] [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-foreground/90",
        className
      )}
      {...props}
    />
  ),
  strong: ({ node: _node, className, ...props }) => (
    <strong
      className={cn("font-semibold text-foreground", className)}
      {...props}
    />
  ),
  em: ({ node: _node, className, ...props }) => (
    <em className={cn("italic", className)} {...props} />
  )
}

// 流式期间用 80ms 节流降低重 parse 频率；完成后立即升级到完整文本。
function useThrottledText(text: string, partial: boolean): string {
  const [throttled, setThrottled] = useState(text)
  const lastSyncRef = useRef(0)
  const pendingRef = useRef<number | null>(null)
  useEffect(() => {
    if (!partial) {
      setThrottled(text)
      return
    }
    const now = Date.now()
    const elapsed = now - lastSyncRef.current
    const flush = () => {
      lastSyncRef.current = Date.now()
      pendingRef.current = null
      setThrottled(text)
    }
    if (elapsed >= 80) {
      flush()
    } else if (pendingRef.current === null) {
      pendingRef.current = window.setTimeout(flush, 80 - elapsed)
    }
    return () => {
      if (pendingRef.current !== null) {
        window.clearTimeout(pendingRef.current)
        pendingRef.current = null
      }
    }
  }, [text, partial])
  return partial ? throttled : text
}

const MarkdownInner = memo(function MarkdownInner({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkReferenceSources]} components={components} urlTransform={(url) => {
      const classification = classifyReference(url, { source: "markdown_link", cwd: "/" })
      return classification.kind === "local" ? url : defaultUrlTransform(url)
    }}>
      {text}
    </ReactMarkdown>
  )
})

export function AssistantMarkdown({
  text,
  partial,
  cwd,
  commands,
  variant = "default"
}: Props) {
  const throttled = useThrottledText(text, !!partial)
  const deferred = useDeferredValue(throttled)
  const sessionCommands = useContext(MarkdownCommandsContext)
  const effectiveCommands = commands ?? sessionCommands
  const referenceContext = useMemo(() => ({ cwd: cwd ?? null, commands: effectiveCommands }), [cwd, effectiveCommands])
  return (
    <div
      className={cn(
        "[font-family:var(--font-reading)] max-w-none min-w-0 text-left text-sm font-normal leading-normal text-foreground [line-break:auto] [overflow-wrap:break-word] [text-align:start] [text-wrap:pretty] [word-break:normal]",
        variant === "activity" &&
          "text-[13px] leading-relaxed text-muted-foreground [&_h1]:my-0 [&_h1]:text-sm [&_h1]:leading-relaxed [&_h1]:text-muted-foreground [&_h2]:my-0 [&_h2]:text-[13px] [&_h2]:leading-relaxed [&_h2]:text-muted-foreground [&_h3]:my-0 [&_h3]:text-[13px] [&_h3]:leading-relaxed [&_h3]:text-muted-foreground [&_li]:text-[13px] [&_li]:leading-relaxed [&_li]:text-muted-foreground [&_ol]:my-1 [&_ol]:text-[13px] [&_p]:my-0 [&_p]:text-[13px] [&_p]:leading-relaxed [&_p]:text-muted-foreground [&_strong]:text-foreground/80 [&_ul]:my-1 [&_ul]:text-[13px]"
      )}
      data-markdown-variant={variant === "activity" ? "activity" : undefined}
    >
      <MarkdownReferenceContext.Provider value={referenceContext}>
        <MarkdownInner text={deferred} />
      </MarkdownReferenceContext.Provider>
      {partial && <span className="caret">▍</span>}
    </div>
  )
}
