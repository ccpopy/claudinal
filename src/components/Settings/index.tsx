import { useEffect, useState } from "react"
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
import { McpServers } from "./sections/McpServers"
import { Environment } from "./sections/Environment"
import { Git } from "./sections/Git"
import { Browser } from "./sections/Browser"
import { Archive as ArchiveSection } from "./sections/Archive"

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  currentCwd?: string | null
}

interface SettingsWorkspaceProps {
  currentCwd?: string | null
  sidebarVisible?: boolean
  initialSection?: string
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
    Component: McpServers
  },
  {
    id: "git",
    label: "Git",
    icon: GitBranch,
    Component: Git
  },
  {
    id: "env",
    label: "环境",
    icon: SlidersHorizontal,
    Component: Environment
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
    Component: Browser
  },
  {
    id: "archive",
    label: "已归档对话",
    icon: Archive,
    Component: ArchiveSection
  },
  {
    id: "account",
    label: "使用情况",
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

export function SettingsWorkspace({
  currentCwd,
  sidebarVisible = true,
  initialSection = "general"
}: SettingsWorkspaceProps) {
  const [section, setSection] = useState<string>(initialSection)
  const cur = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const Cur = cur.Component

  useEffect(() => {
    setSection(initialSection)
  }, [initialSection])

  return (
    <div className="flex h-full min-h-0 flex-1 gap-1.5 bg-sidebar p-1.5 pt-1.5">
      {sidebarVisible && (
        <aside className="w-64 shrink-0 overflow-hidden rounded-lg bg-sidebar text-sidebar-foreground">
          <ScrollArea className="h-full">
            <nav className="flex flex-col gap-0.5 px-2 py-3">
              {SECTIONS.map((s) => {
                const Icon = s.icon
                const active = s.id === section
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSection(s.id)}
                    className={cn(
                      "flex h-9 cursor-pointer items-center gap-3 rounded-md px-3 text-left text-sm font-medium transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-foreground"
                        : "text-sidebar-foreground/85 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground"
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{s.label}</span>
                  </button>
                )
              })}
            </nav>
          </ScrollArea>
        </aside>
      )}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background">
        <Cur cwd={currentCwd ?? null} />
      </main>
    </div>
  )
}

export function Settings({ open, onOpenChange, currentCwd }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl w-[92vw] h-[86vh] p-0 gap-0 overflow-hidden rounded-xl border bg-background shadow-2xl">
        <DialogTitle className="sr-only">设置</DialogTitle>
        <SettingsWorkspace currentCwd={currentCwd} />
      </DialogContent>
    </Dialog>
  )
}
