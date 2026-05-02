import { memo, useDeferredValue, useEffect, useRef, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

interface Props {
  text: string
  partial?: boolean
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
  a: ({ node: _node, className, ...props }) => (
    <a
      className={cn("text-primary underline-offset-4 hover:underline", className)}
      target="_blank"
      rel="noreferrer noopener"
      {...props}
    />
  ),
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
  code: ({ node: _node, className, children, ...props }) => {
    const isInline = !className?.includes("language-")
    if (isInline) {
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
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  )
})

export function AssistantMarkdown({ text, partial }: Props) {
  const throttled = useThrottledText(text, !!partial)
  const deferred = useDeferredValue(throttled)
  return (
    <div className="max-w-none text-left text-sm font-normal leading-normal text-foreground [line-break:auto] [overflow-wrap:break-word] [text-align:start] [text-wrap:pretty] [word-break:normal]">
      <MarkdownInner text={deferred} />
      {partial && <span className="caret">▍</span>}
    </div>
  )
}
