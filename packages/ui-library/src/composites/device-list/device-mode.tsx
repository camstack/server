import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Search, ListChecks, X } from 'lucide-react'
import { UiTrans, useUiText } from '../../contexts/ui-text'
import { DeviceBatchActionsBar } from './batch-actions-bar'
import { allDeviceTypeFilterOptions } from '../device-meta'
import { useDebouncedString } from '../../hooks/use-debounced-string'
import {
  useDeviceListPageSize,
  DEVICE_LIST_PAGE_SIZE_OPTIONS,
} from '../../hooks/use-device-list-page-size'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import type { DeviceItemDevice, DeviceItemParent } from '../device-item/helpers'
import { effectiveType } from '../device-item/helpers'
import { ContainerChildrenProvider } from '../device-item'
import { groupTopLevelAndAccessories, countableDevices } from './group'
import { fuzzyMatch } from './fuzzy-match'
import { Pagination } from './pagination'
import { PageSizeSelect } from './page-size-select'
import { FilterChips } from './filter-chips'
import { DeviceListEmptyState } from './empty-state'
import { useDeviceListUrlState } from './url-state'
import { TableLayout } from './table-layout'
import { columnsForContext, type TableContext } from './columns'
import { nextSort, sortRows, type DeviceSort, type SortableColumnId } from './sort'
import type { MultiSelectOption } from './multi-select'
import type { DeviceIntegrationResolution, DeviceIntegrationResolver } from './device-integration'

/** One chip of the integration filter. `id` is the INTEGRATION id
 *  (`IntegrationWithState.id`), matched against `integrationOf(device)` —
 *  never a device's `addonId` (a composed device is served by `composer` but
 *  belongs to the "Blocks" integration, D659). */
export interface DeviceListIntegrationOption {
  readonly id: string
  readonly name: string
  readonly icon?: ReactNode
}

/** Kept as a source-compatible name for callers compiled against the old
 * addon-keyed filter API. The values are integration ids now. */
export type DeviceListAddonOption = DeviceListIntegrationOption

export type DeviceListIntegrationIconResolver = (
  device: DeviceItemDevice,
  integration: DeviceIntegrationResolution,
) => ReactNode | null

export interface DeviceListDeviceProps {
  /** Discriminant — omit (or 'devices') for the default registry-device list. */
  readonly mode?: 'devices'
  /**
   * Where this table is rendered — selects the visible column subset (table
   * view only). Defaults to `'devices'` (all columns) so every existing
   * call site renders unchanged.
   */
  readonly context?: TableContext
  readonly devices: readonly DeviceItemDevice[]
  readonly trpc: UseDeviceProxyTrpc
  /**
   * Integration filter options + an optional TYPE-filter override.
   *
   * The type filter defaults to the EXHAUSTIVE device-type set
   * (`allDeviceTypeFilterOptions`), so a newly added `DeviceType` appears
   * automatically on every general list and nothing is ever missing. A
   * surface that lists only a known subset (e.g. the export panel restricts
   * to an exporter's supported kinds) may pass `typeOptions` to narrow the
   * dropdown to that subset — built from the same shared meta so labels +
   * icons stay identical.
   */
  readonly filters?: {
    /** Integration chips — ids are integration ids. Requires `integrationOf`. */
    readonly integrations?: readonly DeviceListIntegrationOption[]
    readonly typeOptions?: readonly MultiSelectOption[]
  }
  /**
   * Which integration a row belongs to — build it with
   * `deviceIntegrationResolver(integrations)`, the one rule the whole UI
   * answers that question with. Drives the integration filter
   * (`filters.integrations`, `forceIntegrationId`) and is handed to
   * `resolveIntegrationIcon`. Omitted ⇒ every row is `unknown`, so an
   * integration filter matches nothing.
   */
  readonly integrationOf?: DeviceIntegrationResolver
  /** Pre-applied integration filter (an integration id) — hides the chip group. */
  readonly forceIntegrationId?: string
  /** The badge beside a row's name, given the row and its resolved integration. */
  readonly resolveIntegrationIcon?: DeviceListIntegrationIconResolver
  readonly resolveParent?: (parentId: number) => DeviceItemParent | null
  readonly onNavigate?: (deviceId: number) => void
  readonly pageSize?: { readonly cards: number; readonly table: number }
  readonly urlScope?: 'root' | 'nested'
  /** LocalStorage key prefix. Default 'devices' for root scope, 'integrations:nested' for nested. */
  readonly lsKey?: string
  /**
   * Optional trailing per-row control rendered beside each row's
   * built-in actions (both card + table views, top-level rows only —
   * accessory sub-rows are excluded). Threaded straight through to
   * `<DeviceItem renderRowAction>`. Omitted ⇒ every current call site
   * (Devices, IntegrationDetail, Integrations nested) renders unchanged.
   * Used by `<DeviceExportPanel>` to surface a per-device Expose toggle.
   */
  readonly renderRowAction?: (device: DeviceItemDevice) => ReactNode
  /**
   * Built-in confirmed per-row DELETE — a first-class TABLE feature. When
   * provided, every top-level table row renders a red trash button in the
   * merged actions cell; clicking it opens the shared centered confirm
   * dialog ("Delete device?") and calls `onDeleteDevice(device)` only on
   * confirm. Accessory sub-rows are excluded (same gate as `renderRowAction`).
   * Context gating is "consumer passes the handler or not" — omit it (default)
   * and no trash renders, so existing call sites are unchanged. Cap-agnostic:
   * delete is generic and never branches on the device's capabilities. The
   * confirm is built in, so consumers must NOT add their own. Table-only for
   * now (card delete is a follow-up).
   */
  readonly onDeleteDevice?: (device: DeviceItemDevice) => void
  /**
   * When `true`, renders a leading checkbox on each top-level row
   * (accessory sub-rows are excluded — same gate as `renderRowAction`).
   * Selection state may be controlled via `selectedIds`; when omitted
   * the list maintains internal state.
   */
  readonly selectable?: boolean
  /**
   * Controlled set of selected device ids. Provide together with
   * `onSelectionChange` for a fully controlled selection surface.
   * Omit to let `<DeviceList>` manage internal state.
   */
  readonly selectedIds?: ReadonlySet<number>
  /**
   * Called on every toggle with the NEW full selection set.
   * Invoked for both controlled and uncontrolled usage.
   */
  readonly onSelectionChange?: (ids: ReadonlySet<number>) => void
  /**
   * Opt into self-managed BATCH MODE. When provided, the list renders an
   * "Select" activation button; batch mode is OFF by default (no
   * checkboxes, no bulk toolbar). Activating it reveals the leading
   * row checkboxes plus a responsive bulk-actions bar wired to these
   * callbacks (full toolbar at `sm+`, a compact menu at L1). Selection
   * state is managed internally for the duration of the activated
   * session and cleared on exit. Mutually independent from the
   * lower-level `selectable`/`selectedIds` controlled API.
   */
  readonly batchActions?: DeviceListBatchActions
}

/** Self-managed batch-mode bulk-action callbacks (see `batchActions`). */
export interface DeviceListBatchActions {
  readonly remove: (input: { deviceId: number }) => void
  readonly disable: (input: { deviceId: number }) => void
  readonly enable: (input: { deviceId: number }) => void
}

const DEFAULT_PAGE_SIZE = { cards: 24, table: 50 }

export function DeviceModeList(props: DeviceListDeviceProps): ReactNode {
  const t = useUiText()
  const {
    devices,
    trpc,
    context = 'devices',
    filters,
    forceIntegrationId,
    integrationOf,
    resolveIntegrationIcon,
    resolveParent,
    onNavigate,
    pageSize = DEFAULT_PAGE_SIZE,
    urlScope = 'root',
    lsKey = urlScope === 'root' ? 'devices' : 'integrations:nested',
    renderRowAction,
    onDeleteDevice,
    selectable = false,
    selectedIds,
    onSelectionChange,
    batchActions,
  } = props

  // Batch mode: OFF by default. Only relevant when `batchActions` is
  // provided — the list then owns activation + selection state and
  // renders its own responsive bulk-actions bar.
  const [batchActive, setBatchActive] = useState(false)

  // Selection: controlled when `selectedIds` is provided, else internal state.
  const [internalSelected, setInternalSelected] = useState<ReadonlySet<number>>(new Set())
  const activeSelected: ReadonlySet<number> = selectedIds ?? internalSelected

  const toggleSelection = (id: number): void => {
    const next = new Set(activeSelected)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    if (selectedIds === undefined) {
      setInternalSelected(next)
    }
    onSelectionChange?.(next)
  }

  const clearSelection = (): void => {
    // Notify ONLY in the controlled `selectable`/`selectedIds` path; in the
    // self-managed batchActions path selection is internal, so firing
    // onSelectionChange would spuriously notify a caller wiring up both APIs.
    if (selectedIds === undefined) {
      setInternalSelected(new Set())
    } else {
      onSelectionChange?.(new Set())
    }
  }

  const exitBatchMode = (): void => {
    // Clear BEFORE deactivating: clearSelection reads `selectedIds`/internal
    // state while batch mode is still active, so the ordering is intentional.
    clearSelection()
    setBatchActive(false)
  }

  // Checkboxes render when EITHER the controlled `selectable` flag is set
  // (legacy controlled usage) OR self-managed batch mode is active.
  const showCheckboxes = selectable || (batchActions !== undefined && batchActive)

  // Row-click selects (spec §6) ONLY while self-managed batch mode is active.
  // The legacy controlled `selectable` surface keeps row click = navigate;
  // there the checkbox is the sole selection affordance.
  const rowClickSelects = batchActions !== undefined && batchActive

  // Table-view column subset for this context. Card view is unaffected.
  const visibleColumns = useMemo(() => columnsForContext(context), [context])

  // Column sort (table view only) — owned here so it reorders the TOP-LEVEL
  // rows BEFORE pagination, with accessory children left grouped under their
  // parent (they're resolved per-parent-id, not part of the sorted list).
  // `null` = the default incoming order (current behaviour, unchanged).
  const [sort, setSort] = useState<DeviceSort | null>(null)
  const onSort = (columnId: SortableColumnId): void =>
    setSort((current) => nextSort(current, columnId))

  // Type-filter options: default to the exhaustive device-type set (one per
  // DeviceType member) so the dropdown is complete + identical to every other
  // list surface and a newly added type appears automatically. A caller may
  // override with a deliberately narrower subset (e.g. the export panel).
  const typeOptionsOverride = filters?.typeOptions
  const typeFilterOptions = useMemo<readonly MultiSelectOption[]>(
    () => typeOptionsOverride ?? allDeviceTypeFilterOptions(t),
    [typeOptionsOverride, t],
  )

  const url = useDeviceListUrlState({ scope: urlScope, lsKey })

  // Page size is a GLOBAL, persisted user preference (shared across the
  // Devices / Integrations / integration-detail surfaces) seeded from the
  // table default. It used to be conditional — the cards view carried a static
  // default of its own — and with the cards view gone there is one number.
  // `setTablePageSize` only accepts allowed options, so a stray value is a
  // no-op.
  const [tablePageSize, setTablePageSize] = useDeviceListPageSize(pageSize.table)
  const currentPageSize = tablePageSize

  const [searchInput, setSearchInput] = useState(url.state.q)
  const debouncedSearch = useDebouncedString(searchInput, 300)
  // Intentionally only depend on `debouncedSearch` — re-firing on every
  // url.state.q change would create a write-loop (effect writes setQ →
  // state changes → effect fires).
  useEffect(() => {
    if (debouncedSearch !== url.state.q) url.setQ(debouncedSearch)
  }, [debouncedSearch])

  // `forceIntegrationId` (a parent context locking one integration) wins and
  // collapses to a single-element set; otherwise the multi-select drives
  // the filter. Empty set = no integration filter.
  const effectiveAddons = useMemo<readonly string[]>(
    () => (forceIntegrationId !== undefined ? [forceIntegrationId] : url.state.addons),
    [forceIntegrationId, url.state.addons],
  )
  const integrationOfRow = useCallback<DeviceIntegrationResolver>(
    (device) => (integrationOf !== undefined ? integrationOf(device) : { kind: 'unknown' }),
    [integrationOf],
  )
  // Children grouped by parent id so the type filter can resolve a container's
  // EFFECTIVE type (its primary child's type) — a container is otherwise the
  // structural `container` and slips through a `vacuum` filter.
  const childrenByParent = useMemo(() => {
    const map = new Map<number, DeviceItemDevice[]>()
    for (const d of devices) {
      if (d.parentDeviceId === null || d.parentDeviceId === undefined) continue
      const list = map.get(d.parentDeviceId)
      if (list) list.push(d)
      else map.set(d.parentDeviceId, [d])
    }
    return map
  }, [devices])

  const filtered = useMemo(() => {
    const q = url.state.q
    const addonSet = effectiveAddons.length > 0 ? new Set(effectiveAddons) : null
    const typeSet = url.state.types.length > 0 ? new Set(url.state.types) : null
    return devices.filter((d) => {
      if (addonSet && !belongsToAny(integrationOfRow(d), addonSet)) return false
      if (typeSet && !typeSet.has(effectiveType(d, childrenByParent.get(d.id)))) return false
      if (q.trim() !== '' && !fuzzyMatch(q, d.name) && !fuzzyMatch(q, d.stableId)) {
        return false
      }
      return true
    })
  }, [devices, childrenByParent, effectiveAddons, integrationOfRow, url.state.types, url.state.q])

  const grouped = useMemo(() => groupTopLevelAndAccessories(filtered), [filtered])

  // The row's badge is asked with the row's RESOLVED integration, from the
  // same `integrationOf` the filter uses — so the icon and the filter can
  // never name two different integrations for one row.
  const rowIntegrationIcon = useMemo(
    () =>
      resolveIntegrationIcon === undefined
        ? null
        : (d: DeviceItemDevice): ReactNode | null => resolveIntegrationIcon(d, integrationOfRow(d)),
    [resolveIntegrationIcon, integrationOfRow],
  )

  // Sorted top-level rows (immutable — `sortRows` returns a new array; `null`
  // sort = a fresh copy in the original order). Accessory grouping is untouched:
  // `grouped.accessoriesByParent` still keys children to their parent id, so a
  // sorted parent keeps its children attached below it.
  const sortedTopLevel = useMemo(() => sortRows(grouped.topLevel, sort), [grouped.topLevel, sort])

  // Which parent rows are OPEN — and only the chevron writes this set.
  //
  // A search used to open every parent one of whose accessories matched the
  // term. On this fleet the accessories carry their parent's name, so the
  // term that finds a container also matches all of its children and the
  // search became a wall of accessory rows. A search narrows; it never
  // expands.
  //
  // The set lives here, above the rows, so it is the operator's and nothing
  // else's: a parent opened by hand stays open through a search that filters
  // it out and back, and through a page change — state kept inside the row
  // died with the row.
  const [openParents, setOpenParents] = useState<ReadonlySet<number>>(() => new Set())
  const toggleParent = useCallback((id: number): void => {
    setOpenParents((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const totalItems = grouped.topLevel.length
  const totalPages = Math.max(1, Math.ceil(totalItems / currentPageSize))
  const safePage = Math.min(url.state.page, totalPages)
  const startIdx = (safePage - 1) * currentPageSize
  const pageRows = sortedTopLevel.slice(startIdx, startIdx + currentPageSize)

  // Same intent as the search effect above — only fire on safePage
  // changes; depending on url.state.page or url.setPage would create
  // a write loop.
  useEffect(() => {
    if (safePage !== url.state.page) url.setPage(safePage)
  }, [safePage])

  useDeviceListRealtimeSync()

  const isFiltered = effectiveAddons.length > 0 || url.state.types.length > 0 || url.state.q !== ''
  const isEmpty = totalItems === 0
  // An integration filter over rows whose integration is not KNOWN yet (the
  // integrations query has not answered) matched nothing because it could
  // not judge, not because nothing is there. Saying "no devices match"
  // would claim an absence nobody observed (D315).
  const integrationPending = useMemo(
    () => effectiveAddons.length > 0 && devices.some((d) => integrationOfRow(d).kind === 'unknown'),
    [effectiveAddons, devices, integrationOfRow],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <FilterChips
          typeOptions={typeFilterOptions}
          selectedTypes={url.state.types}
          onTypesChange={url.setTypes}
          addons={filters?.integrations}
          selectedAddons={url.state.addons}
          query={url.state.q}
          onClearFilters={() => {
            // The debounced search input is local state; clearing only the URL
            // would let the next debounce tick write the old term straight
            // back and re-filter the list the operator just cleared.
            setSearchInput('')
            url.clearFilters()
          }}
          onAddonsChange={url.setAddons}
          hideAddons={forceIntegrationId !== undefined}
        />
        <div className="flex items-center gap-2">
          {batchActions !== undefined &&
            (batchActive ? (
              <button
                type="button"
                onClick={exitBatchMode}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border bg-surface text-[11px] font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
              >
                <X className="h-3 w-3" />
                {t('uiLibrary.deviceModeList.done', 'Done')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setBatchActive(true)}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border bg-surface text-[11px] font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
              >
                <ListChecks className="h-3 w-3" />
                {t('uiLibrary.deviceModeList.select', 'Select')}
              </button>
            ))}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-foreground-subtle pointer-events-none" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t(
                'uiLibrary.deviceModeList.searchPlaceholder',
                'Search by name or stableId',
              )}
              aria-label={t(
                'uiLibrary.deviceModeList.searchAria',
                'Search devices by name or stableId',
              )}
              className="h-7 pl-7 pr-2.5 rounded-md border border-border bg-surface text-[11px] text-foreground placeholder:text-foreground-subtle/60 focus:outline-none focus:ring-1 focus:ring-primary/40 w-56"
            />
          </div>
        </div>
      </div>

      {/* Bulk-actions bar — visible only while batch mode is active AND at
          least one device is selected. Responsive: full toolbar at sm+, a
          compact menu at L1 (handled inside DeviceBatchActionsBar). */}
      {batchActions !== undefined && batchActive && (
        <DeviceBatchActionsBar
          selectedIds={activeSelected}
          onClear={clearSelection}
          remove={batchActions.remove}
          disable={batchActions.disable}
          enable={batchActions.enable}
        />
      )}

      {isEmpty ? (
        <DeviceListEmptyState
          variant={integrationPending ? 'pending' : isFiltered ? 'filtered' : 'nofilter'}
          onClearFilters={isFiltered && !integrationPending ? url.clearFilters : undefined}
        />
      ) : (
        <ContainerChildrenProvider value={grouped.accessoriesByParent}>
          <TableLayout
            rows={pageRows}
            accessoriesByParent={grouped.accessoriesByParent}
            expandedParents={openParents}
            onToggleExpand={toggleParent}
            visibleColumns={visibleColumns}
            sort={sort}
            onSort={onSort}
            // Pass the FILTERED list, not the unfiltered `devices` prop:
            // the indent computation looks up parent.type to flag adopted
            // rows. If the parent is filtered out (e.g. user picks
            // type='camera' and the Home hub disappears), we don't want
            // the orphaned child to keep its indent — the visual cue is
            // meaningful only when the parent is also visible.
            devices={filtered}
            trpc={trpc}
            resolveIntegrationIcon={rowIntegrationIcon}
            resolveParent={resolveParent ?? null}
            onNavigate={onNavigate ?? null}
            renderRowAction={renderRowAction ?? null}
            onDeleteDevice={onDeleteDevice ?? null}
            selectable={showCheckboxes}
            rowClickSelects={rowClickSelects}
            activeSelected={activeSelected}
            onToggleSelection={toggleSelection}
          />
        </ContainerChildrenProvider>
      )}

      {/* Bottom controls — per-page size selector + total count alongside the
       * pager. Rendered whenever the table list is non-empty so the size can
       * be changed even on a single page; the pager itself self-hides when
       * there's only one page (totalPages <= 1).
       *
       * Exactly ONE count is ever shown: when the list spans multiple pages
       * the pager renders its own "Showing X–Y of N devices" range, so the
       * standalone total on the left would be redundant and is suppressed.
       * On a single page (totalItems <= tablePageSize) the pager hides, and
       * the standalone total is the only count. The "Per page" selector is
       * always visible (list non-empty). */}
      {!isEmpty && (
        <div className="flex items-center justify-between gap-4 flex-wrap pt-2 text-[11px] text-foreground-subtle">
          <div className="inline-flex items-center gap-2">
            {totalItems <= tablePageSize && (
              <span>
                {t(
                  'uiLibrary.deviceModeList.deviceCount',
                  { one: '{{count}} device', other: '{{count}} devices' },
                  { count: totalItems },
                )}
              </span>
            )}
            <PageSizeSelect
              ariaLabel={t('uiLibrary.deviceModeList.devicesPerPage', 'Devices per page')}
              value={tablePageSize}
              options={DEVICE_LIST_PAGE_SIZE_OPTIONS}
              // Only the size changes; the safePage clamp effect lands the user
              // on a valid page (clamping down only when the new size makes the
              // current page out of range). An explicit reset to page 1 here
              // would wrongly bounce the user off a page a larger size keeps.
              onChange={setTablePageSize}
            />
          </div>
          <Pagination
            currentPage={safePage}
            totalItems={totalItems}
            pageSize={currentPageSize}
            onPageChange={url.setPage}
          />
        </div>
      )}

      {/* Footer hidden in nested mode (forceIntegrationId = expanded inside a
       * parent table) — the surrounding context already names the
       * integration, so the "filtered by X" line is redundant. Pagination
       * is the only useful overall affordance there, and it lives above. */}
      {forceIntegrationId === undefined && isFiltered && totalItems > 0 && (
        <p className="text-[11px] text-foreground-subtle">
          {effectiveAddons.length > 0 ? (
            <UiTrans
              uiKey="uiLibrary.deviceModeList.showingFiltered"
              fallback={{
                one: 'Showing {{shown}} of {{count}} device · filtered by <0>{{names}}</0>',
                other: 'Showing {{shown}} of {{count}} devices · filtered by <0>{{names}}</0>',
              }}
              components={[<strong key="names" className="text-primary" />]}
              values={{
                shown: totalItems,
                count: countableDevices(devices).length,
                names: effectiveAddons
                  .map((id) => filters?.integrations?.find((a) => a.id === id)?.name ?? id)
                  .join(', '),
              }}
            />
          ) : (
            t(
              'uiLibrary.deviceModeList.showing',
              {
                one: 'Showing {{shown}} of {{count}} device',
                other: 'Showing {{shown}} of {{count}} devices',
              },
              { shown: totalItems, count: countableDevices(devices).length },
            )
          )}
        </p>
      )}
    </div>
  )
}

/**
 * A row matches an integration filter only when it RESOLVED to one of the
 * picked integrations. `unknown` (integrations not answered yet), `orphan`
 * and `unlinked` rows belong to none of them.
 */
function belongsToAny(
  resolution: DeviceIntegrationResolution,
  integrationIds: ReadonlySet<string>,
): boolean {
  return resolution.kind === 'resolved' && integrationIds.has(resolution.integration.id)
}

function useDeviceListRealtimeSync(): void {
  // TODO(post-phase-2): lift the realtime sync into ui-library once a
  // context bridge for the admin-ui-specific BackendClient exists.
  // Today, per-page useEventInvalidation calls in admin-ui (Devices.tsx
  // + Integrations.tsx) remain authoritative; this stub only enforces
  // that consumers have a QueryClient ancestor.
  useQueryClient()
}
