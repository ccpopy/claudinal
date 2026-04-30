import { useState } from "react"
import {
  Archive,
  BarChart3,
  Cog,
  GitBranch,
  Globe,
  Key,
  Monitor,
  Network as NetworkIcon,
  Plug,
  Settings2,
  Sliders,
  SlidersHorizontal,
  TreePine,
  UserCircle,
  type LucideIcon
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogTitle
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { General } from "./sections/General"
import { Appearance } from "./sections/Appearance"
import { Network } from "./sections/Network"
import { Config } from "./sections/Config"
import { Account } from "./sections/Account"
import { Statistics } from "./sections/Statistics"
import { Placeholder } from "./sections/Placeholder"
import { Personalization } from "./sections/Personalization"
import { ThirdPartyApi } from "./sections/ThirdPartyApi"

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  currentCwd?: string | null
}

interface SectionDef {
  id: string
  label: string
  icon: LucideIcon
  Component: React.ComponentType<{ cwd?: string | null }>
}

const SECTIONS: SectionDef[] = [
  { id: "general", label: "常规", icon: Cog, Component: General },
  { id: "appearance", label: "外观", icon: Sliders, Component: Appearance },
  {
    id: "config",
    label: "配置",
    icon: Settings2,
    Component: Config
  },
  {
    id: "third-party-api",
    label: "第三方 API",
    icon: Key,
    Component: ThirdPartyApi
  },
  {
    id: "personalization",
    label: "个性化",
    icon: UserCircle,
    Component: Personalization
  },
  {
    id: "mcp",
    label: "MCP 服务器",
    icon: Plug,
    Component: () => <Placeholder title="MCP 服务器" />
  },
  {
    id: "git",
    label: "Git",
    icon: GitBranch,
    Component: () => <Placeholder title="Git" />
  },
  {
    id: "env",
    label: "环境",
    icon: SlidersHorizontal,
    Component: () => <Placeholder title="环境" />
  },
  {
    id: "worktree",
    label: "工作树",
    icon: TreePine,
    Component: () => <Placeholder title="工作树" />
  },
  {
    id: "browser",
    label: "浏览器使用",
    icon: Globe,
    Component: () => <Placeholder title="浏览器使用" />
  },
  {
    id: "archive",
    label: "已归档对话",
    icon: Archive,
    Component: () => <Placeholder title="已归档对话" />
  },
  {
    id: "account",
    label: "Usage",
    icon: Monitor,
    Component: Account
  },
  {
    id: "statistics",
    label: "统计",
    icon: BarChart3,
    Component: Statistics
  },
  {
    id: "network",
    label: "网络代理",
    icon: NetworkIcon,
    Component: Network
  }
]

export function Settings({ open, onOpenChange, currentCwd }: Props) {
  const [section, setSection] = useState<string>("appearance")
  const cur = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const Cur = cur.Component
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[90vw] h-[85vh] p-0 gap-0 grid grid-rows-1 grid-cols-[220px_1fr] overflow-hidden">
        <DialogTitle className="sr-only">设置</DialogTitle>
        <aside className="bg-sidebar border-r border-sidebar-border flex flex-col">
          <div className="px-4 py-3 flex items-center">
            <span className="text-xs uppercase tracking-wider text-sidebar-muted">
              设置
            </span>
          </div>
          <ScrollArea className="flex-1">
            <div className="px-2 pb-3 flex flex-col gap-0.5">
              {SECTIONS.map((s) => {
                const Icon = s.icon
                const active = s.id === section
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSection(s.id)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left",
                      active
                        ? "bg-sidebar-accent text-sidebar-foreground"
                        : "hover:bg-sidebar-accent/60 text-sidebar-foreground/80"
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{s.label}</span>
                  </button>
                )
              })}
            </div>
          </ScrollArea>
        </aside>
        <div className="bg-background h-full min-h-0 overflow-hidden flex flex-col">
          <Cur cwd={currentCwd ?? null} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
