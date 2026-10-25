/**
 * SectionedPage — page + section shell (OSD Manager template).
 *
 * One `PageShell` (title + icon matching the sidebar entry) and a library
 * `Tabs` strip for sections. URL owns the active section (`?tab=` by default)
 * unless the caller passes controlled `activeSection` / `onSectionChange`
 * (admin-ui with react-router). Leaving a section drops its `ownedParams`.
 * Section bodies must not wrap another `PageShell` — one gutter only.
 */
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode, type JSX } from 'react'
import { Tabs, TabsList, TabsTrigger } from '../primitives'
import { PageShell } from './page-shell'
import { StableTabPanel } from './stable-tab-panel'

export interface SectionedPageSection {
  readonly id: string
  readonly label: string
  readonly content: ReactNode
  /**
   * Query keys that belong to this section. Cleared when the operator leaves
   * so a stale editor / filter does not reopen on return.
   */
  readonly ownedParams?: readonly string[]
}

export interface SectionedPageProps {
  readonly icon?: LucideIcon
  /** Required unless `sectionsOnly` (nested under another SectionedPage). */
  readonly title?: string
  readonly subtitle?: ReactNode
  readonly actions?: ReactNode
  readonly sections: readonly SectionedPageSection[]
  readonly defaultSection?: string
  /** Search-param for the active section id. Default `tab`. Uncontrolled only. */
  readonly paramName?: string
  /** Accessible name for the section tablist. */
  readonly sectionsLabel?: string
  readonly className?: string
  /**
   * Tabs + body only — no PageShell. Use for an inner strip (Library → Events
   * Feed/Debug) when the parent already owns the page chrome.
   */
  readonly sectionsOnly?: boolean
  /**
   * Controlled section id (e.g. from react-router `useSearchParams`). When set
   * with `onSectionChange`, the component does not touch `window.history`.
   */
  readonly activeSection?: string
  readonly onSectionChange?: (id: string, ownedParamsToClear: readonly string[]) => void
  /**
   * Fill the parent height so a section body can host a flex-filling DataTable.
   * Forwarded to `PageShell`; ignored for `sectionsOnly`.
   */
  readonly fill?: boolean
}

function readSearch(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

function replaceSearch(mutate: (params: URLSearchParams) => void): void {
  const params = readSearch()
  mutate(params)
  const qs = params.toString()
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
  window.history.replaceState(null, '', url)
}

export function SectionedPage({
  icon,
  title,
  subtitle,
  actions,
  sections,
  defaultSection,
  paramName = 'tab',
  sectionsLabel,
  className,
  sectionsOnly = false,
  activeSection: controlledActive,
  onSectionChange,
  fill = false,
}: SectionedPageProps): JSX.Element {
  const controlled = controlledActive !== undefined && onSectionChange !== undefined
  const fallback = defaultSection ?? sections[0]?.id ?? ''
  const [urlTab, setUrlTab] = useState<string | null>(() =>
    controlled ? null : readSearch().get(paramName),
  )

  useEffect(() => {
    if (controlled) return
    const onPop = (): void => setUrlTab(readSearch().get(paramName))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [controlled, paramName])

  const rawActive = controlled ? controlledActive : urlTab
  const activeId = sections.some((s) => s.id === rawActive) ? (rawActive ?? fallback) : fallback
  const active = sections.find((s) => s.id === activeId) ?? sections[0]

  const setActive = useCallback(
    (id: string): void => {
      const ownedToClear = id !== activeId ? (active?.ownedParams ?? []) : []
      if (controlled) {
        onSectionChange(id, ownedToClear)
        return
      }
      replaceSearch((params) => {
        for (const param of ownedToClear) params.delete(param)
        params.set(paramName, id)
      })
      setUrlTab(id)
    },
    [active?.ownedParams, activeId, controlled, onSectionChange, paramName],
  )

  const listLabel =
    sectionsLabel ?? (title !== undefined && title !== '' ? `${title} sections` : 'Sections')

  const tabs = (
    <Tabs value={activeId} onValueChange={setActive} className={fill ? 'shrink-0' : undefined}>
      <TabsList aria-label={listLabel}>
        {sections.map((section) => (
          <TabsTrigger key={section.id} value={section.id} data-testid={`section-${section.id}`}>
            {section.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
  const panel = (
    <StableTabPanel tabKey={activeId} fill={fill}>
      {fill ? (
        <div className="flex min-h-0 flex-1 flex-col">{active?.content}</div>
      ) : (
        active?.content
      )}
    </StableTabPanel>
  )
  const strip = fill ? (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {tabs}
      {panel}
    </div>
  ) : (
    <>
      {tabs}
      {panel}
    </>
  )

  if (sectionsOnly) {
    return (
      <div
        className={
          fill
            ? `flex h-full min-h-0 flex-col gap-3 ${className ?? ''}`
            : className
              ? `space-y-3 ${className}`
              : 'space-y-3'
        }
        data-testid="sectioned-page-sections-only"
      >
        {strip}
      </div>
    )
  }

  return (
    <PageShell
      icon={icon}
      title={title ?? ''}
      subtitle={subtitle}
      actions={actions}
      fill={fill}
      className={className}
    >
      {strip}
    </PageShell>
  )
}
