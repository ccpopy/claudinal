import { Folder, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Project } from "@/lib/projects"

interface Props {
  project: Project | null
  onAddProject: () => void
  suggestions?: string[]
  onPickSuggestion?: (s: string) => void
}

export function Welcome({
  project,
  onAddProject,
  suggestions,
  onPickSuggestion
}: Props) {
  if (!project) {
    return (
      <div className="max-w-md text-center space-y-4">
        <div className="inline-flex items-center justify-center size-12 rounded-full bg-primary/10 text-primary">
          <Sparkles className="size-6" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          欢迎使用 Claudinal
        </h1>
        <p className="text-muted-foreground text-sm">
          添加一个工作目录开始对话。
        </p>
        <Button onClick={onAddProject} size="lg" className="mt-2">
          <Folder />
          添加项目
        </Button>
      </div>
    )
  }

  return (
    <div className="w-full max-w-2xl flex flex-col items-center gap-4">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          要在 <span className="text-primary">{project.name}</span> 中构建什么？
        </h1>
        <p className="text-xs text-muted-foreground font-mono break-all">
          {project.cwd}
        </p>
      </div>
      {suggestions && suggestions.length > 0 && onPickSuggestion && (
        <div className="w-full flex flex-col gap-1.5 mt-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPickSuggestion(s)}
              className="text-left px-3 py-2 rounded-md text-sm hover:bg-accent transition-colors flex items-center gap-2 border border-transparent hover:border-border text-muted-foreground hover:text-foreground"
            >
              <Sparkles className="size-3.5 shrink-0 opacity-70" />
              <span>{s}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
