/**
 * Tab strip used by the combined system pages (Identity, Network, Data).
 *
 * Active tab is reflected in the URL via `?tab=<id>` so deep links + back
 * navigation work. Tabs are rendered horizontally with the active one
 * underlined, mirroring the visual idiom used by the Settings shadcn-like
 * components elsewhere in the admin UI.
 */
import { Tabs, TabsList, TabsTrigger } from '@camstack/ui-library'
import { useSearchParams } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { StableTabPanel } from './StableTabPanel'

export interface AdminTab {
  readonly id: string
  readonly label: string
  readonly icon?: LucideIcon
  readonly content: ReactNode
  /**
   * URL params that belong to THIS tab (e.g. a filter another tab seeded).
   * Dropped when the operator leaves the tab, so coming back through the strip
   * opens the tab on its own defaults rather than on a stale seed.
   */
  readonly ownedParams?: readonly string[]
}

export interface AdminTabsProps {
  readonly tabs: readonly AdminTab[]
  readonly defaultTab?: string
  /**
   * Search-param that carries the active tab id. Default `tab`. Use another
   * name (e.g. `section`) when this strip is nested under a page that already
   * owns `?tab=` — one `?tab=` strip per address.
   */
  readonly paramName?: string
}

export function AdminTabs({ tabs, defaultTab, paramName = 'tab' }: AdminTabsProps): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlTab = searchParams.get(paramName)
  const fallback = defaultTab ?? tabs[0]?.id ?? ''
  const activeId = tabs.some((t) => t.id === urlTab) ? urlTab! : fallback
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]

  const setActive = (id: string): void => {
    const next = new URLSearchParams(searchParams)
    if (id !== activeId) {
      for (const param of active?.ownedParams ?? []) next.delete(param)
    }
    next.set(paramName, id)
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="space-y-3">
      <Tabs value={activeId} onValueChange={setActive}>
        <TabsList className="border-border">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <TabsTrigger key={tab.id} value={tab.id} className="h-auto py-2 border-b-2">
                {Icon !== undefined && <Icon className="h-3.5 w-3.5" aria-hidden />}
                {tab.label}
              </TabsTrigger>
            )
          })}
        </TabsList>
      </Tabs>
      {/* Each `content` is a whole page component, so a tab switch cold-mounts
          one and its first frame is a loading stub. Without the height hold the
          scroll container collapses and the browser clamps scrollTop to 0 — see
          StableTabPanel. */}
      <StableTabPanel tabKey={activeId}>{active?.content}</StableTabPanel>
    </div>
  )
}
