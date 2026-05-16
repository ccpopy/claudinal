import {
  Suspense,
  lazy,
  useEffect,
  useState,
  type ComponentType,
  type LazyExoticComponent
} from "react"
import {
  Archive,
  BarChart3,
  Bot,
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
import type { SessionMeta } from "@/lib/ipc"
import type { Project } from "@/lib/projects"
import { cn } from "@/lib/utils"

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  currentCwd?: string | null
}

interface SettingsWorkspaceProps {
  currentCwd?: string | null
  sidebarVisible?: boolean
  initialSection?: string
  onSelectProject?: (project: Project) => void
  onSelectSession?: (project: Project, session: SessionMeta) => void
  onProjectsChanged?: () => void
}

interface SectionProps {
  cwd?: string | null
  onSelectProject?: (project: Project) => void
  onSelectSession?: (project: Project, session: SessionMeta) => void
  onProjectsChanged?: () => void
}

type SectionGroupKey = "app" | "model" | "tooling" | "data"

interface SectionDef {
  id: string
  label: string
  icon: LucideIcon
  group: SectionGroupKey
  Component:
    | ComponentType<SectionProps>
    | LazyExoticComponent<ComponentType<SectionProps>>
  load?: () => Promise<unknown>
}

const GROUP_LABELS: Record<SectionGroupKey, string> = {
  app: "应用",
  model: "模型与会话",
  tooling: "工程工具",
  data: "数据"
}

const GROUP_ORDER: SectionGroupKey[] = ["app", "model", "tooling", "data"]

const loadGeneral = () => import("./sections/General")
const loadAppearance = () => import("./sections/Appearance")
const loadConfig = () => import("./sections/Config")
const loadThirdPartyApi = () => import("./sections/ThirdPartyApi")
const loadPersonalization = () => import("./sections/Personalization")
const loadMcpServers = () => import("./sections/McpServers")
const loadCollaboration = () => import("./sections/Collaboration")
const loadGit = () => import("./sections/Git")
const loadEnvironment = () => import("./sections/Environment")
const loadWorktree = () => import("./sections/Worktree")
const loadBrowser = () => import("./sections/Browser")
const loadArchive = () => import("./sections/Archive")
const loadAccount = () => import("./sections/Account")
const loadStatistics = () => import("./sections/Statistics")
const loadNetwork = () => import("./sections/Network")

const General = lazy(() => loadGeneral().then((m) => ({ default: m.General })))
const Appearance = lazy(() =>
  loadAppearance().then((m) => ({ default: m.Appearance }))
)
const Config = lazy(() => loadConfig().then((m) => ({ default: m.Config })))
const ThirdPartyApi = lazy(() =>
  loadThirdPartyApi().then((m) => ({ default: m.ThirdPartyApi }))
)
const Personalization = lazy(() =>
  loadPersonalization().then((m) => ({ default: m.Personalization }))
)
const McpServers = lazy(() =>
  loadMcpServers().then((m) => ({ default: m.McpServers }))
)
const Collaboration = lazy(() =>
  loadCollaboration().then((m) => ({ default: m.Collaboration }))
)
const Git = lazy(() => loadGit().then((m) => ({ default: m.Git })))
const Environment = lazy(() =>
  loadEnvironment().then((m) => ({ default: m.Environment }))
)
const Worktree = lazy(() =>
  loadWorktree().then((m) => ({ default: m.Worktree }))
)
const Browser = lazy(() => loadBrowser().then((m) => ({ default: m.Browser })))
const ArchiveSection = lazy(() =>
  loadArchive().then((m) => ({ default: m.Archive }))
)
const Account = lazy(() => loadAccount().then((m) => ({ default: m.Account })))
const Statistics = lazy(() =>
  loadStatistics().then((m) => ({ default: m.Statistics }))
)
const Network = lazy(() => loadNetwork().then((m) => ({ default: m.Network })))

const SECTIONS: SectionDef[] = [
  {
    id: "general",
    label: "常规",
    icon: Cog,
    group: "app",
    Component: General,
    load: loadGeneral
  },
  {
    id: "appearance",
    label: "外观",
    icon: Sliders,
    group: "app",
    Component: Appearance,
    load: loadAppearance
  },
  {
    id: "network",
    label: "网络代理",
    icon: NetworkIcon,
    group: "app",
    Component: Network,
    load: loadNetwork
  },
  {
    id: "config",
    label: "配置",
    icon: Settings2,
    group: "model",
    Component: Config,
    load: loadConfig
  },
  {
    id: "third-party-api",
    label: "第三方 API",
    icon: Key,
    group: "model",
    Component: ThirdPartyApi,
    load: loadThirdPartyApi
  },
  {
    id: "personalization",
    label: "个性化",
    icon: UserCircle,
    group: "model",
    Component: Personalization,
    load: loadPersonalization
  },
  {
    id: "mcp",
    label: "MCP 服务器",
    icon: Plug,
    group: "model",
    Component: McpServers,
    load: loadMcpServers
  },
  {
    id: "collaboration",
    label: "协同",
    icon: Bot,
    group: "model",
    Component: Collaboration,
    load: loadCollaboration
  },
  {
    id: "git",
    label: "Git",
    icon: GitBranch,
    group: "tooling",
    Component: Git,
    load: loadGit
  },
  {
    id: "env",
    label: "环境",
    icon: SlidersHorizontal,
    group: "tooling",
    Component: Environment,
    load: loadEnvironment
  },
  {
    id: "worktree",
    label: "工作树",
    icon: TreePine,
    group: "tooling",
    Component: Worktree,
    load: loadWorktree
  },
  {
    id: "browser",
    label: "浏览器使用",
    icon: Globe,
    group: "tooling",
    Component: Browser,
    load: loadBrowser
  },
  {
    id: "account",
    label: "账户和使用情况",
    icon: Monitor,
    group: "data",
    Component: Account,
    load: loadAccount
  },
  {
    id: "statistics",
    label: "统计",
    icon: BarChart3,
    group: "data",
    Component: Statistics,
    load: loadStatistics
  },
  {
    id: "archive",
    label: "已归档对话",
    icon: Archive,
    group: "data",
    Component: ArchiveSection,
    load: loadArchive
  }
]

function SectionLoader() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
      <div className="h-7 w-40 rounded-md bg-muted" />
      <div className="grid gap-3">
        <div className="h-24 rounded-lg border bg-card" />
        <div className="h-24 rounded-lg border bg-card" />
        <div className="h-16 rounded-lg border bg-card" />
      </div>
    </div>
  )
}

export function SettingsWorkspace({
  currentCwd,
  sidebarVisible = true,
  initialSection = "general",
  onSelectProject,
  onSelectSession,
  onProjectsChanged
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
            <nav className="flex flex-col px-2 py-3">
              {GROUP_ORDER.map((groupKey, groupIdx) => {
                const items = SECTIONS.filter((s) => s.group === groupKey)
                if (items.length === 0) return null
                return (
                  <div
                    key={groupKey}
                    className={cn("flex flex-col", groupIdx > 0 && "mt-2")}
                  >
                    <div className="flex h-7 items-center px-2 text-xs font-medium text-sidebar-foreground/60">
                      {GROUP_LABELS[groupKey]}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {items.map((s) => {
                        const Icon = s.icon
                        const active = s.id === section
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onMouseEnter={() => void s.load?.()}
                            onFocus={() => void s.load?.()}
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
                    </div>
                  </div>
                )
              })}
            </nav>
          </ScrollArea>
        </aside>
      )}
	      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background">
	        <Suspense fallback={<SectionLoader />}>
	          <Cur
              cwd={currentCwd ?? null}
              onSelectProject={onSelectProject}
              onSelectSession={onSelectSession}
              onProjectsChanged={onProjectsChanged}
            />
	        </Suspense>
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
