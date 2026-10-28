const EXPANDED_PROJECTS_KEY = "claudinal.sidebar.expanded-projects"
const COLLAPSED_SECTIONS_KEY = "claudinal.sidebar.collapsed-sections"
export type SidebarSection = "projects" | "recent"

export function listSidebarCollapsedSections(): SidebarSection[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? "[]")
    return Array.isArray(value)
      ? [...new Set(value.filter((item): item is SidebarSection => item === "projects" || item === "recent"))]
      : []
  } catch {
    return []
  }
}

export function saveSidebarCollapsedSections(sections: Iterable<SidebarSection>) {
  localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...sections]))
}

export function listSidebarExpandedProjectIds(): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_PROJECTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return uniqueProjectIds(parsed)
  } catch {
    return []
  }
}

export function saveSidebarExpandedProjectIds(projectIds: Iterable<string>) {
  localStorage.setItem(
    EXPANDED_PROJECTS_KEY,
    JSON.stringify(uniqueProjectIds([...projectIds]))
  )
}

function uniqueProjectIds(values: unknown[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const value of values) {
    if (typeof value !== "string") continue
    const id = value.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}
