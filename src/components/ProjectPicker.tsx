import { useMemo, useState } from "react"
import { Check, ChevronDown, Folder, FolderPlus, Search, X } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { Project } from "@/lib/projects"

interface Props {
  projects: Project[]
  current: Project | null
  onSelect: (p: Project) => void
  onAdd: () => void
  onClear: () => void
  className?: string
}

export function ProjectPicker({
  projects,
  current,
  onSelect,
  onAdd,
  onClear,
  className
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return projects
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.cwd.toLowerCase().includes(q)
    )
  }, [projects, query])

  const label = current?.name ?? "选择项目"

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) setQuery("")
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-xs text-foreground/90 hover:bg-accent transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            className
          )}
        >
          <Folder className="size-3.5 opacity-70" />
          <span className="truncate max-w-[160px]">{label}</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 p-0">
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b">
          <Search className="size-3.5 opacity-60 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索项目"
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            autoFocus
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1 scrollbar-thin">
          {filtered.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground text-center">
              无匹配项目
            </div>
          ) : (
            filtered.map((p) => {
              const active = p.id === current?.id
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onSelect(p)
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent rounded-sm cursor-pointer text-left"
                >
                  <Folder className="size-3.5 opacity-70 shrink-0" />
                  <span className="flex-1 truncate">{p.name}</span>
                  {active && <Check className="size-3.5 text-primary shrink-0" />}
                </button>
              )
            })
          )}
        </div>
        <div className="border-t py-1">
          <button
            type="button"
            onClick={() => {
              onAdd()
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent rounded-sm cursor-pointer text-left"
          >
            <FolderPlus className="size-3.5 opacity-70 shrink-0" />
            <span>添加新项目</span>
          </button>
          {current && (
            <button
              type="button"
              onClick={() => {
                onClear()
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent rounded-sm cursor-pointer text-left"
            >
              <X className="size-3.5 opacity-70 shrink-0" />
              <span>不使用项目</span>
            </button>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
