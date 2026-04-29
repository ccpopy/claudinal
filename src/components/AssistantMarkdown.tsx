import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

interface Props {
  text: string
  partial?: boolean
}

const components: Components = {
  p: ({ className, ...props }) => (
    <p
      className={cn(
        "text-sm leading-relaxed text-foreground my-2 first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "text-lg font-semibold text-foreground mt-4 mb-2",
        className
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "text-base font-semibold text-foreground mt-3 mb-2",
        className
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "text-sm font-semibold text-foreground mt-3 mb-1",
        className
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn("list-disc pl-5 my-2 space-y-1 text-sm", className)}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn("list-decimal pl-5 my-2 space-y-1 text-sm", className)}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("leading-relaxed", className)} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn("text-primary underline-offset-4 hover:underline", className)}
      target="_blank"
      rel="noreferrer noopener"
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "border-l-2 border-primary/40 pl-3 my-2 text-muted-foreground italic",
        className
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn("border-border my-3", className)} {...props} />
  ),
  table: ({ className, ...props }) => (
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
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "border border-border bg-muted px-2 py-1 text-left font-semibold",
        className
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn("border border-border px-2 py-1 align-top", className)}
      {...props}
    />
  ),
  code: ({ className, children, ...props }) => {
    const isInline = !className?.includes("language-")
    if (isInline) {
      return (
        <code
          className={cn(
            "px-1 py-0.5 rounded bg-muted text-foreground/90 font-mono text-[12px]",
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
        className={cn("font-mono text-[12px] text-foreground/90", className)}
        {...props}
      >
        {children}
      </code>
    )
  },
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "p-3 my-2 rounded-md bg-muted/60 border text-[12px] font-mono whitespace-pre-wrap break-words overflow-auto scrollbar-thin text-foreground/90 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-foreground/90",
        className
      )}
      {...props}
    />
  ),
  strong: ({ className, ...props }) => (
    <strong
      className={cn("font-semibold text-foreground", className)}
      {...props}
    />
  ),
  em: ({ className, ...props }) => (
    <em className={cn("italic", className)} {...props} />
  )
}

export function AssistantMarkdown({ text, partial }: Props) {
  return (
    <div className="text-sm leading-relaxed text-foreground break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
      {partial && <span className="caret">▍</span>}
    </div>
  )
}
