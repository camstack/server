import type { DeviceSearchRequires } from '@camstack/types'
import { Search } from 'lucide-react'
import { type JSX, type UIEvent, useMemo, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { capabilityListLabel } from '../../lib/capability-label'
import { Button } from '../../primitives/button'
import { Skeleton } from '../../primitives/skeleton'
import { INPUT_SHELL } from '../device-picker/SelectedChip'
import { DeviceValueRail } from './device-value-rail'
import { DeviceRows, ListState, ValuesPage } from './device-value-rows'
import {
  buildSections,
  derivePickerState,
  excludeItems,
  hasFacets,
  NO_FACETS,
  type FacetSelection,
  type PickedValue,
  type PickKind,
  toggleFacet,
  toSearchFilters,
} from './device-value-picker-model'
import {
  SEARCH_DEBOUNCE_MS,
  useDebouncedValue,
  useDeviceValueSearch,
  useResolvedDevices,
} from './use-device-value-search'

/** How close to the bottom (px) the list asks for the next page. */
const NEXT_PAGE_THRESHOLD_PX = 96

export interface DeviceValuePanelProps {
  readonly requires?: DeviceSearchRequires
  readonly contextDeviceId?: number
  /** Device types the field is fixed to (a `device-select` filter), narrowed by the Type facet. */
  readonly fixedTypes?: readonly string[]
  readonly excludeIds?: readonly number[]
  readonly excludeTypes?: readonly string[]
  readonly kind: PickKind
  readonly multiple: boolean
  readonly picked: readonly PickedValue[]
  readonly onSelect: (value: PickedValue) => void
  /** Start with the filter rail (the popover variant). */
  readonly railFirst: boolean
  /** Ids this field offered last time, most recent first. */
  readonly recentIds: readonly number[]
  /** Focus the search on mount (default true: the panel opened from a click). */
  readonly autoFocus?: boolean
}

/**
 * The picker's dropdown body: search, the "{Capability} · N match of M"
 * line, the optional filter rail, and the list. The inline variant starts
 * without the rail and escalates to it with "Browse all…" keeping the query.
 */
export function DeviceValuePanel(props: DeviceValuePanelProps): JSX.Element {
  const t = useUiText()
  const [text, setText] = useState('')
  const [facets, setFacets] = useState<FacetSelection>(NO_FACETS)
  const [railOpen, setRailOpen] = useState(props.railFirst)
  const [showIncompatible, setShowIncompatible] = useState(false)
  const [drilled, setDrilled] = useState<number | null>(null)
  const debounced = useDebouncedValue(text.trim(), SEARCH_DEBOUNCE_MS)

  const caps = props.requires?.caps ?? []
  const hasCap = caps.length > 0
  const capLabel = capabilityListLabel(caps, t, t('uiLibrary.deviceValuePicker.or', 'or'))
  const search = useDeviceValueSearch(
    {
      text: debounced === '' ? undefined : debounced,
      requires: props.requires,
      filters: toSearchFilters(facets, props.fixedTypes),
      includeIncompatible: showIncompatible || undefined,
      contextDeviceId: props.contextDeviceId,
    },
    true,
  )
  const recent = useResolvedDevices(props.recentIds, props.requires)
  const narrowed = debounced !== '' || hasFacets(facets)
  const exclude = { ids: props.excludeIds, types: props.excludeTypes }
  const items = useMemo(
    () => excludeItems(search.items, exclude),
    [search.items, props.excludeIds, props.excludeTypes],
  )
  const suggested = excludeItems(search.first?.suggested ?? [], exclude)
  const recentItems = excludeItems(
    (recent.result?.items ?? []).filter((i) => i.compatible),
    exclude,
  )
  const state = derivePickerState({
    isPending: search.isPending,
    isError: search.isError,
    result: search.first,
    itemCount: items.length,
    narrowed,
  })
  const sections = useMemo(
    () => buildSections({ items, suggested, recent: recentItems, shortlist: !narrowed }),
    [items, suggested, recentItems, narrowed],
  )
  const drilledItem = drilled === null ? undefined : items.find((i) => i.id === drilled)
  const inPlace = railOpen
  const first = search.first

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < NEXT_PAGE_THRESHOLD_PX) {
      search.fetchNextPage()
    }
  }

  return (
    <div data-dvp-panel="" className="flex max-h-[min(70vh,34rem)] min-h-0 flex-col sm:flex-row">
      {first !== undefined && (
        // Desktop: the filter rail is always there. Phone: it opens with "Browse all…".
        <div className={cn('flex min-h-0 flex-col sm:contents', !railOpen && 'hidden')}>
          <DeviceValueRail
            facets={first.facets}
            selection={facets}
            onToggle={(key, value) => setFacets((f) => toggleFacet(f, key, value))}
          />
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-col gap-1.5 border-b border-border p-2">
          <div className={INPUT_SHELL}>
            <Search className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
            <input
              type="search"
              autoFocus={props.autoFocus !== false}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setDrilled(null)
              }}
              placeholder={t('uiLibrary.deviceValuePicker.search', 'Search name, room, type or id')}
              aria-label={t('uiLibrary.deviceValuePicker.searchLabel', 'Search devices')}
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-foreground-subtle"
              onKeyDown={(e) => {
                if (e.key !== 'ArrowDown') return
                e.currentTarget
                  .closest('[data-dvp-panel]')
                  ?.querySelector<HTMLElement>('[data-dvp-row]')
                  ?.focus()
              }}
            />
          </div>
          {first === undefined ? (
            <Skeleton className="h-4 w-40" />
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-foreground-muted">
              <span>
                {hasCap
                  ? t(
                      'uiLibrary.deviceValuePicker.matchesOf',
                      {
                        one: '{{cap}} · {{count}} match of {{total}}',
                        other: '{{cap}} · {{count}} matches of {{total}}',
                      },
                      { cap: capLabel, count: first.compatibleTotal, total: first.fleetTotal },
                    )
                  : t(
                      'uiLibrary.deviceValuePicker.devicesCount',
                      { one: '{{count}} device', other: '{{count}} devices' },
                      { count: first.total },
                    )}
              </span>
              {first.hiddenIncompatible > 0 && (
                <Button
                  variant="unstyled"
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setShowIncompatible((v) => !v)}
                >
                  {showIncompatible
                    ? t('uiLibrary.deviceValuePicker.hideIncompatible', 'hide the ones that don’t')
                    : t(
                        'uiLibrary.deviceValuePicker.showIncompatible',
                        'show the {{count}} that don’t',
                        {
                          count: first.hiddenIncompatible,
                        },
                      )}
                </Button>
              )}
            </div>
          )}
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={onScroll}
          data-testid="dvp-scroll"
        >
          {state.kind !== 'ready' ? (
            <ListState
              state={state}
              capLabel={capLabel}
              hasCap={hasCap}
              query={debounced}
              onRetry={search.refetch}
            />
          ) : drilledItem !== undefined && !inPlace ? (
            <ValuesPage
              item={drilledItem}
              multiple={props.multiple}
              picked={props.picked}
              onSelect={props.onSelect}
              onBack={() => setDrilled(null)}
            />
          ) : (
            <>
              <DeviceRows
                sections={sections}
                kind={props.kind}
                multiple={props.multiple}
                picked={props.picked}
                onSelect={props.onSelect}
                inPlace={inPlace}
                expandedId={drilled}
                onDrill={setDrilled}
                capLabel={capLabel}
              />
              {search.isFetchingNextPage && <Skeleton className="m-3 h-8" />}
            </>
          )}
        </div>
        {!railOpen && (
          <div className="border-t border-border p-1.5 sm:hidden">
            <Button variant="ghost" size="sm" onClick={() => setRailOpen(true)}>
              {t('uiLibrary.deviceValuePicker.browseAll', 'Browse all…')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
