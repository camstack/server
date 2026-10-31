/**
 * SearchResultsList — presentational rendering of grouped global-search
 * results (see lib/global-search.ts for the filter/rank logic this
 * renders). Kept dumb on purpose: all state (query, active index, open/
 * closed) lives in GlobalSearch.tsx so this component is trivial to reason
 * about and test visually in isolation.
 */
import { Camera, Compass, Plug, type LucideIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchDomain, SearchItem, SearchResultGroup } from '../../lib/global-search'
import { Button } from '@camstack/ui-library'

const DOMAIN_META: Record<SearchDomain, { readonly labelKey: string; readonly icon: LucideIcon }> =
  {
    device: { labelKey: 'search.resultsList.devices', icon: Camera },
    page: { labelKey: 'search.resultsList.pages', icon: Compass },
    integration: { labelKey: 'search.resultsList.integrations', icon: Plug },
  }

interface SearchResultsListProps {
  readonly groups: readonly SearchResultGroup[]
  readonly activeKey: string | null
  readonly query: string
  /** Total matches BEFORE the `MAX_TOTAL_RESULTS` safety cap — what the
   *  truncation notice's "of M" refers to (see global-search.ts). */
  readonly totalMatched: number
  /** True when `groups` holds fewer items than `totalMatched` because the
   *  cap engaged. Must be surfaced, never dropped silently. */
  readonly truncated: boolean
  readonly onSelect: (item: SearchItem) => void
  readonly onHover: (item: SearchItem) => void
}

export function SearchResultsList({
  groups,
  activeKey,
  query,
  totalMatched,
  truncated,
  onSelect,
  onHover,
}: SearchResultsListProps) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement | null>(null)

  // Arrow-key navigation moves `activeKey` without scrolling the list on its
  // own — follow the active row into view so the operator can see what
  // Enter is about to select, even once the result count outgrows 60vh.
  useEffect(() => {
    if (!activeKey) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(activeKey)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeKey])

  if (query.trim().length === 0) return null

  if (groups.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-[12px] text-foreground-subtle">
        {t('search.resultsList.noResults', { query })}
      </div>
    )
  }

  const shown = groups.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <>
      <div ref={listRef} role="listbox" className="max-h-[60vh] overflow-y-auto py-1">
        {groups.map((group) => {
          const meta = DOMAIN_META[group.domain]
          const GroupIcon = meta.icon
          return (
            <div key={group.domain} className="px-1 py-1">
              <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-foreground-subtle/60">
                <GroupIcon className="h-3 w-3" />
                {t(meta.labelKey)}
              </div>
              {group.items.map((item) => {
                const ItemIcon = item.icon ?? meta.icon
                const active = item.key === activeKey
                return (
                  <Button
                    variant="unstyled"
                    key={item.key}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-key={item.key}
                    onMouseEnter={() => onHover(item)}
                    onClick={() => onSelect(item)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
                      active
                        ? 'bg-primary/12 text-primary'
                        : 'text-foreground hover:bg-surface-hover'
                    }`}
                  >
                    <ItemIcon
                      className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-primary' : 'text-foreground-subtle'}`}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block truncate font-medium">{item.label}</span>
                      {item.subtitle && (
                        <span className="block truncate text-[10px] text-foreground-subtle">
                          {item.subtitle}
                        </span>
                      )}
                    </span>
                  </Button>
                )
              })}
            </div>
          )
        })}
      </div>
      {truncated && (
        <div className="border-t border-border px-3 py-1.5 text-center text-[10px] text-foreground-subtle">
          {t(
            'search.truncatedResults',
            'Showing first {{shown}} of {{total}} — refine your search.',
            { shown, total: totalMatched },
          )}
        </div>
      )}
    </>
  )
}
