import type { TFunction } from 'i18next'
import { type AdoptionFilter, type DiscoveredChildDevice, DeviceType } from '@dominevo/types'
import {
  allDeviceTypeFilterOptions,
  Button,
  DeviceList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  deviceTypeMetaOf,
  useDeviceManagerAdoptionListCandidateFilters,
  useDeviceManagerAdoptionListCandidates,
  useDeviceManagerAdoptionRefresh,
  useDeviceManagerAdoptionStartJob,
  useIntegrationsGetAvailableTypes,
  useUiText,
  Checkbox,
} from '@dominevo/ui-library'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  RotateCw,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AdoptedMark } from './AdoptedMark'
import { AdoptJobProgress } from './AdoptJobProgress'
import { candidateDistinguisher, orderCandidatesAsTree } from './adopt-candidate-rows'
import { candidateSearchText } from './adopt-candidate-search'
import { CandidateParamsStep, RowAddButton, ScanControls } from './NetworkCandidatesPanel'
import { type NetworkRow, useNetworkScan } from './use-network-scan'

// The reserved, universal default granularity. A provider that declares no
// filters is treated as a single implicit `devices` filter — exactly the
// pre-existing behavior (no selector, current look unchanged).
const DEFAULT_FILTER_ID = 'devices'
function implicitDefaultFilter(t: TFunction): AdoptionFilter {
  return {
    id: DEFAULT_FILTER_ID,
    label: t('integrations.adoptDevicesModal.defaultFilter'),
    isDefault: true,
  }
}

// Pagination is CLIENT-side (the shared <DeviceList mode="generic"> paginates
// locally at this page size). We fetch the whole candidate set in one request —
// the large case is the HA `entities` granularity (one device → many entities,
// several thousand candidates); the cap allows up to 20000.
const FETCH_ALL_PAGE_SIZE = 20000
const CLIENT_PAGE_SIZE = 100

/**
 * Per-candidate adoption overrides. Built lazily as the operator toggles
 * child visibility — empty unless they hide a child, so the common path
 * sends no `perCandidate` payload at all.
 */
interface PerCandidateOverride {
  hiddenChildIds: ReadonlySet<string>
}

interface AdoptDevicesModalProps {
  addonId: string
  integrationId: string
  onClose: () => void
  /**
   * The integration also finds devices by a network scan: the list then carries every device found,
   * the ones the adoption provider lists and the ones only the scan or passive discovery saw, in ONE
   * table, with the scan controls above it.
   */
  withScan?: boolean
}

/**
 * One row of the single list: a device the adoption provider lists (with the scan hit that matches
 * it, when there is one) or a device only the scan or passive discovery found.
 */
type ListItem =
  | {
      readonly kind: 'candidate'
      readonly candidate: DiscoveredChildDevice
      readonly found: NetworkRow | null
    }
  | { readonly kind: 'found'; readonly row: NetworkRow }

interface AdoptedState {
  readonly adopted: boolean
  /** The hub device the row is, when the hub (or the provider) said which one. */
  readonly deviceId: number | null
}

/** Whether a row is a device the hub already holds, and which: whichever source knew. */
function adoptedStateOf(item: ListItem, added: ReadonlySet<string>): AdoptedState {
  if (item.kind === 'found') {
    return {
      adopted: item.row.alreadyAdded || added.has(item.row.key),
      deviceId: item.row.deviceId,
    }
  }
  const { candidate, found } = item
  const adopted =
    candidate.alreadyAdopted || (found !== null && (found.alreadyAdded || added.has(found.key)))
  return {
    adopted,
    deviceId: candidate.adoptedDeviceId ?? found?.deviceId ?? null,
  }
}

function itemKey(item: ListItem): string {
  return item.kind === 'candidate' ? item.candidate.childNativeId : item.row.key
}

function itemSearchText(item: ListItem): string {
  return item.kind === 'candidate'
    ? candidateSearchText(item.candidate)
    : `${item.row.name} ${item.row.address ?? ''}`.toLowerCase()
}

/**
 * `AdoptDevicesModal` — the GENERIC adopt surface, bound by the
 * `device-adoption` cap (NOT HA-specific). Opened with an `integrationId`,
 * it PREVIEWS the integration's candidate devices (commit-on-Add) and
 * adopts the selected ones through the `device-manager` adoption PROXY
 * methods. Nothing here branches on the addon — every row is driven purely
 * by the shared `DiscoveredChildDevice` candidate data, so any integration
 * declaring the cap renders the same panel.
 *
 * Lifecycle: candidates are cache-backed; a cold cache returns an empty
 * list. So on open we fire `adoptionRefresh({addonId, integrationId})` to
 * warm the cache (spinner while pending), then read the paginated candidate
 * list. "Add selected" commits the preview via `adoptionAdopt`.
 */
export function AdoptDevicesModal({ addonId, integrationId, onClose }: AdoptDevicesModalProps) {
  const { t } = useTranslation()
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      {/* Fixed height (not max-h) on desktop so the dialog never resizes between
          the loading / list / empty / error states — the body scrolls instead of
          the whole modal bouncing. */}
      <DialogContent width="xl" scroll="body" className="md:h-[85vh]">
        <DialogHeader>
          <DialogTitle>
            {t('integrations.adoptDevices', { defaultValue: 'Adopt devices' })}
          </DialogTitle>
          <DialogDescription>
            {t('integrations.adoptDevicesHint', {
              defaultValue: 'Preview the candidate devices and add the ones you want.',
            })}
          </DialogDescription>
        </DialogHeader>
        <AdoptDevicesPanel addonId={addonId} integrationId={integrationId} onClose={onClose} />
      </DialogContent>
    </Dialog>
  )
}

/**
 * The adopt surface WITHOUT its dialog frame: location import, the candidate
 * list, the job progress and the footer. The Add device modal mounts it as a
 * tab; `AdoptDevicesModal` mounts it alone.
 */
export function AdoptDevicesPanel({
  addonId,
  integrationId,
  onClose,
  withScan = false,
}: AdoptDevicesModalProps) {
  const uiText = useUiText()
  const { t } = useTranslation()

  // Selection persists across the client-paginated/filtered list, so the
  // "Add selected (N)" counter reflects every candidate, not just the page.
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  // childNativeId → override. Only candidates with a non-empty hidden set
  // appear here, so the common path sends no `perCandidate` payload.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, PerCandidateOverride>>(new Map())
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Whether this integration's source system exposes importable locations
  // (e.g. HA areas) — sourced from the SAME available-types entry the
  // IntegrationDetail page resolves the addon's kind/brokerKind from. When
  // true the header renders an "import locations" checkbox (default ON) and
  // the adopt call carries the operator's choice.
  const { data: availableTypes } = useIntegrationsGetAvailableTypes()
  const supportsLocationImport =
    (availableTypes ?? []).find((a) => a.addonId === addonId)?.supportsLocationImport ?? false
  const [importLocations, setImportLocations] = useState(true)

  // Provider-declared discovery GRANULARITY filters, fetched on open via the
  // device-manager adoption PROXY (addonId-routed, so it reaches THIS
  // integration's provider — not the device-adoption singleton shadow). A
  // provider that declares none — or exactly one — is treated as the implicit
  // single `devices` filter, so the selector is hidden and the look is unchanged.
  const filtersQuery = useDeviceManagerAdoptionListCandidateFilters({
    addonId,
    integrationId,
  })
  const declaredFilters = filtersQuery.data?.filters
  const filters: readonly AdoptionFilter[] =
    declaredFilters && declaredFilters.length > 0 ? declaredFilters : [implicitDefaultFilter(t)]

  // Active granularity. Defaults to the provider's `isDefault` filter, else the
  // reserved `devices` id, else the first declared filter.
  const defaultFilterId =
    filters.find((f) => f.isDefault)?.id ??
    (filters.some((f) => f.id === DEFAULT_FILTER_ID) ? DEFAULT_FILTER_ID : filters[0].id)
  const [activeFilter, setActiveFilter] = useState<string>(defaultFilterId)

  // The entities granularity yields flat per-entity candidates (no children),
  // so the expansion tree + per-child hide (devices-granularity concepts) are
  // disabled for it — just selectable flat rows.
  const isFlatFilter = activeFilter !== DEFAULT_FILTER_ID

  const refreshMutation = useDeviceManagerAdoptionRefresh()

  // Candidates are read from the integration's discovery CACHE and shown
  // immediately on open — warmed on broker-connect, so this renders instantly
  // with no blocking live HA round-trip. We fetch the WHOLE set in one request
  // (no server pagination); the shared <DeviceList> paginates + filters
  // client-side. A live re-query happens only on the Refresh button or the
  // one-shot cold-cache warm below.
  const listQuery = useDeviceManagerAdoptionListCandidates({
    addonId,
    integrationId,
    page: 1,
    pageSize: FETCH_ALL_PAGE_SIZE,
    filter: activeFilter,
  })
  const refetch = listQuery.refetch

  // Force a fresh discovery (re-query HA) then refetch the cached list. Drives
  // both the manual "Refresh" button and the one-shot cold-cache warm.
  const refreshMutate = refreshMutation.mutate
  const doRefresh = useCallback(() => {
    refreshMutate(
      { addonId, integrationId },
      {
        onSettled: () => {
          void refetch()
        },
      },
    )
  }, [refreshMutate, addonId, integrationId, refetch])

  // Warm a COLD cache once per (addonId, integrationId): after the first cache
  // read resolves, if it came back empty, kick ONE background refresh. The
  // cached list stays visible meanwhile — no blocking spinner. A cache already
  // warmed on broker-connect skips this (no redundant live query on open).
  const warmedKey = useRef<string | null>(null)
  useEffect(() => {
    const key = `${addonId}::${integrationId}`
    if (warmedKey.current === key || listQuery.isLoading) return
    warmedKey.current = key
    if ((listQuery.data?.candidates.length ?? 0) === 0) doRefresh()
  }, [addonId, integrationId, listQuery.isLoading, listQuery.data, doRefresh])

  const isRefreshing = refreshMutation.isPending
  // Surface a failed discovery explicitly so the empty state doesn't mask it.
  const warmError = refreshMutation.isError
    ? refreshMutation.error instanceof Error
      ? refreshMutation.error.message
      : String(refreshMutation.error)
    : null
  // A successful refresh that still found nothing can carry lastError (Wyze
  // swallows cloud fetch failures so live cameras keep running). Treat that
  // as a discovery failure, not a genuine empty account.
  const refreshStatusError =
    typeof refreshMutation.data?.lastError === 'string' && refreshMutation.data.lastError.length > 0
      ? refreshMutation.data.lastError
      : null

  const listData = listQuery.data
  const candidates: readonly DiscoveredChildDevice[] = useMemo(
    () => listData?.candidates ?? [],
    [listData],
  )
  // Children (`parentStableId`) nest under their parent, in tree order.
  const treeRows = useMemo(() => orderCandidatesAsTree(candidates), [candidates])

  // The scan side of the single list: found devices merge with the adoption candidates by identity,
  // so one device is one row whichever source saw it. The scan only speaks for the default
  // granularity — a flat per-entity list has no network device to match.
  const adoptionEntries = useMemo(
    () =>
      candidates.map((c) => ({
        childNativeId: c.childNativeId,
        name: c.name,
        alreadyAdopted: c.alreadyAdopted,
        adoptedDeviceId: c.adoptedDeviceId,
        parentStableId: c.parentStableId,
        mac: c.metadata.mac,
      })),
    [candidates],
  )
  const scan = useNetworkScan({
    addonId,
    integrationId,
    adoption: adoptionEntries,
    enabled: withScan,
  })
  const scanActive = withScan && activeFilter === DEFAULT_FILTER_ID
  const items = useMemo<readonly ListItem[]>(() => {
    const foundByAdoptionId = new Map(
      scan.rows.flatMap((r) => (r.adoptionId !== null ? [[r.adoptionId, r] as const] : [])),
    )
    const fromAdoption = treeRows.map<ListItem>((r) => ({
      kind: 'candidate',
      candidate: r.candidate,
      found: scanActive ? (foundByAdoptionId.get(r.candidate.childNativeId) ?? null) : null,
    }))
    const foundOnly = scanActive
      ? scan.rows
          .filter((r) => r.adoptionId === null)
          .map<ListItem>((row) => ({ kind: 'found', row }))
      : []
    return [...fromAdoption, ...foundOnly]
  }, [treeRows, scan.rows, scanActive])
  const depthById = useMemo(
    () => new Map(treeRows.map((r) => [r.candidate.childNativeId, r.depth])),
    [treeRows],
  )
  const parentNameById = useMemo(
    () => new Map(treeRows.map((r) => [r.candidate.childNativeId, r.parentName])),
    [treeRows],
  )

  // A failed candidate fetch falls back to `[]`; without this the empty
  // state would mask the fetch failure. Carry the error so the body renders
  // it instead of the genuine empty state.
  const listError = listQuery.isError
    ? listQuery.error instanceof Error
      ? listQuery.error.message
      : String(listQuery.error)
    : null

  // Adoption runs as a JOB, not inside this request. `adoptionAdopt` put the
  // whole selection behind ONE transport deadline: measured on the live hub the
  // kernel spends ~450 ms per device it creates and an accessory child costs
  // what its parent costs, so 25 candidates — and equally a SINGLE candidate
  // with 217 children — both exceed it. `adoptionStartJob` returns a jobId
  // immediately and adopts one candidate per call.
  const adoptMutation = useDeviceManagerAdoptionStartJob()
  const [jobId, setJobId] = useState<string | null>(null)

  const toggleSelect = useCallback((candidate: DiscoveredChildDevice) => {
    if (candidate.alreadyAdopted) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(candidate.childNativeId)) next.delete(candidate.childNativeId)
      else next.add(candidate.childNativeId)
      return next
    })
  }, [])

  const toggleExpand = useCallback((childNativeId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(childNativeId)) next.delete(childNativeId)
      else next.add(childNativeId)
      return next
    })
  }, [])

  const toggleChildHidden = useCallback((parentId: string, childId: string) => {
    setOverrides((prev) => {
      const next = new Map(prev)
      const current = next.get(parentId)?.hiddenChildIds ?? new Set<string>()
      const hidden = new Set(current)
      if (hidden.has(childId)) hidden.delete(childId)
      else hidden.add(childId)
      if (hidden.size === 0) next.delete(parentId)
      else next.set(parentId, { hiddenChildIds: hidden })
      return next
    })
  }, [])

  // Map the per-candidate UI overrides into the cap's `perCandidate`
  // payload shape — only emit entries for selected candidates that actually
  // hide a child.
  const buildPerCandidate = useCallback(
    (selectedIds: readonly string[]): Record<string, { hiddenChildIds: string[] }> | undefined => {
      const out: Record<string, { hiddenChildIds: string[] }> = {}
      for (const id of selectedIds) {
        const override = overrides.get(id)
        if (override && override.hiddenChildIds.size > 0) {
          out[id] = { hiddenChildIds: [...override.hiddenChildIds] }
        }
      }
      return Object.keys(out).length > 0 ? out : undefined
    },
    [overrides],
  )

  const handleAdopt = useCallback(async () => {
    setSubmitError(null)
    const childNativeIds = [...selected]
    if (childNativeIds.length === 0) return
    try {
      // The `filter` threads to the cap via the device-manager proxy's
      // `...rest` passthrough (the proxy input reuses the adoption cap's
      // schema, which carries the optional `filter`) — no core change.
      const perCandidate = buildPerCandidate(childNativeIds)
      const { jobId: started } = await adoptMutation.mutateAsync({
        addonId,
        integrationId,
        filter: activeFilter,
        childNativeIds,
        ...(perCandidate ? { perCandidate } : {}),
        ...(supportsLocationImport ? { importLocations } : {}),
      })
      // The modal STAYS OPEN and follows the job. Closing here would recreate
      // the defect this replaced: work continuing with nobody able to see which
      // candidates landed.
      setJobId(started)
      setSelected(new Set())
      setOverrides(new Map())
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    }
  }, [
    selected,
    buildPerCandidate,
    adoptMutation,
    addonId,
    integrationId,
    activeFilter,
    supportsLocationImport,
    importLocations,
  ])

  // A finished job flips the adopted rows in the candidate list. Guarded by a
  // ref so the progress strip's render-time completion signal refetches once
  // rather than on every poll.
  const settledJobRef = useRef<string | null>(null)
  const onJobFinished = useCallback(() => {
    if (jobId === null || settledJobRef.current === jobId) return
    settledJobRef.current = jobId
    void refetch()
    // …and the PAGE BEHIND, which is what the operator is looking at once this
    // dialog closes. `refetch()` above only refreshes the candidate list INSIDE
    // the modal, so a device adopted here did not appear on the integration
    // until the page was reloaded by hand — the work had landed and the screen
    // said otherwise. These are the same two slices every other mutation on
    // `IntegrationDetail` invalidates.
    void queryClient.invalidateQueries({ queryKey: [['integrations']] })
    void queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
  }, [jobId, refetch, queryClient])

  // Switching granularity clears the selection + per-child overrides + expansion
  // (the ids are filter-relative, so they must not bleed across filters).
  const onSelectFilter = useCallback((filterId: string) => {
    setActiveFilter(filterId)
    setSelected(new Set())
    setExpanded(new Set())
    setOverrides(new Map())
    setSubmitError(null)
  }, [])

  const selectedCount = selected.size
  /**
   * The adopting is DONE and there is nothing else picked — so the primary
   * action is to leave, not to adopt nothing.
   *
   * The dialog deliberately stays open after a job starts, to show which
   * candidates landed; but once it has and the selection is empty, the primary
   * button sat there disabled saying "Add selected", and the only way out was
   * the secondary "Cancel" — which reads like undoing what just happened.
   *
   * `jobId` is the whole condition: before the first adopt there is nothing to
   * close over and "Cancel" is the honest word for leaving.
   */
  const adoptionDone = jobId !== null && selectedCount === 0 && !adoptMutation.isPending

  const foundCount = items.filter(
    (i) => i.kind === 'found' || (i.found !== null && i.found.hit !== null),
  ).length
  const discoveryFailed = (warmError ?? listError ?? refreshStatusError) && candidates.length === 0
  // Nothing listed is worded by what was asked: a merged list names the scan, never the bare
  // "no candidates"; a pending or failed answer says nothing at all (D315).
  const emptyLabel = discoveryFailed
    ? ''
    : scanActive
      ? scan.proposals !== 'answered' || scan.scanning
        ? ''
        : scan.scanAnswered
          ? t('integrations.addDeviceModal.nothingFound', 'No devices responded to the scan.')
          : t('integrations.addDeviceModal.scanHint', 'Scan the network to find devices to add.')
      : t('integrations.adoptNoCandidates', {
          defaultValue: 'No candidate devices found.',
        })

  // A found device that needs a value the provider cannot guess opens its creation form in place
  // of the list, prefilled with what was found.
  if (scan.paramsFor !== null && scan.paramsFor.hit !== null) {
    return (
      <CandidateParamsStep
        addonId={addonId}
        integrationId={integrationId}
        row={scan.paramsFor}
        found={scan.paramsFor.hit.prefilledConfig}
        busy={scan.busy.has(scan.paramsFor.key)}
        error={scan.error}
        embedded={false}
        onBack={() => scan.setParamsFor(null)}
        onSubmit={(values) => {
          if (scan.paramsFor !== null) void scan.addRow(scan.paramsFor, values)
        }}
      />
    )
  }

  return (
    <>
      {withScan && <ScanControls scan={scan} listed={scanActive ? foundCount : 0} />}
      {supportsLocationImport && (
        <label className="flex items-center gap-1.5 cursor-pointer text-[11px] text-foreground-subtle hover:text-foreground transition-colors">
          <Checkbox
            checked={importLocations}
            onChange={(e) => setImportLocations(e.target.checked)}
            className="accent-primary"
          />
          {t('integrations.importLocations', {
            defaultValue: 'Import locations from the integration',
          })}
        </label>
      )}

      {/* Body — the shared <DeviceList> in generic mode owns search +
            pagination (client-side); the Refresh action sits in its toolbar.
            Selection + per-row controls live in CandidateRow (renderItem). */}
      <div className="flex-1 min-h-0 flex flex-col gap-2 overflow-hidden">
        {(warmError ?? listError ?? refreshStatusError) && candidates.length === 0 && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 shrink-0">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-danger mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-danger">
                  {t('integrations.adoptRefreshFailed', {
                    defaultValue: 'Could not discover devices.',
                  })}
                </p>
                <p className="text-[11px] text-danger/90 mt-0.5">
                  {warmError ?? listError ?? refreshStatusError}
                </p>
              </div>
            </div>
          </div>
        )}
        {filters.length > 1 && (
          <FilterSelector filters={filters} activeFilter={activeFilter} onSelect={onSelectFilter} />
        )}
        <div className="flex-1 min-h-0">
          <DeviceList
            mode="generic"
            items={items}
            pageSize={CLIENT_PAGE_SIZE}
            getKey={itemKey}
            getSearchText={itemSearchText}
            getFilterType={(item) =>
              item.kind === 'candidate' ? item.candidate.type : (item.row.hit?.type ?? null)
            }
            filterOptions={allDeviceTypeFilterOptions(uiText)}
            filterLabel={t('integrations.adoptColType', {
              defaultValue: 'Type',
            })}
            isLoading={listQuery.isLoading || (isRefreshing && candidates.length === 0)}
            searchPlaceholder={t('integrations.adoptSearch', {
              defaultValue: 'Search candidates…',
            })}
            emptyLabel={emptyLabel}
            toolbar={
              <Button
                variant="unstyled"
                type="button"
                onClick={doRefresh}
                disabled={isRefreshing}
                title={t('integrations.adoptRefreshTitle', {
                  defaultValue: "Reload this integration's device list (does not scan the network)",
                })}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-60 shrink-0"
              >
                <RotateCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                {t('integrations.adoptRefresh', { defaultValue: 'Refresh' })}
              </Button>
            }
            columns={[
              {
                // Name cell follows the unified generic convention: a
                // chevron-in-name-cell expand affordance (left), then the
                // device name + adopted mark, the same shape as the
                // integrations list's `name` column. The candidate-specific
                // entity count rides next to the chevron.
                key: 'name',
                header: t('integrations.adoptColName', {
                  defaultValue: 'Name',
                }),
                // `max-w-0` lets the cell shrink to its column so a long name
                // truncates instead of pushing the selection column off-screen.
                headerClassName: 'w-full sm:w-[55%]',
                cellClassName: 'max-w-0',
                cell: (item) => {
                  const state = adoptedStateOf(item, scan.added)
                  if (item.kind === 'found') {
                    return (
                      <FoundNameCell
                        row={item.row}
                        adopted={state.adopted}
                        deviceId={state.deviceId}
                        typeLabel={
                          deviceTypeMetaOf(item.row.hit?.type ?? DeviceType.Camera, uiText).label
                        }
                        alignWithChevron={!isFlatFilter}
                        onNavigate={onClose}
                      />
                    )
                  }
                  const c = item.candidate
                  return (
                    <CandidateNameCell
                      candidate={c}
                      depth={depthById.get(c.childNativeId) ?? 0}
                      {...(parentNameById.get(c.childNativeId) !== undefined
                        ? { containerName: parentNameById.get(c.childNativeId) }
                        : {})}
                      // Flat granularities (e.g. entities) have no children to
                      // expand: render a plain selectable row, no chevron.
                      expandable={!isFlatFilter}
                      expanded={expanded.has(c.childNativeId)}
                      onToggleExpand={() => toggleExpand(c.childNativeId)}
                      adopted={state.adopted}
                      deviceId={state.deviceId}
                      onNavigate={onClose}
                      typeLabel={deviceTypeMetaOf(c.type, uiText).label}
                    />
                  )
                },
              },
              {
                // Type: icon + label from the exhaustive device-type map.
                key: 'type',
                header: t('integrations.adoptColType', {
                  defaultValue: 'Type',
                }),
                headerClassName: 'w-[30%] hidden sm:table-cell',
                cellClassName: 'hidden sm:table-cell',
                cell: (item) => {
                  const type =
                    item.kind === 'candidate'
                      ? item.candidate.type
                      : (item.row.hit?.type ?? DeviceType.Camera)
                  const meta = deviceTypeMetaOf(type, uiText)
                  const Icon = meta.icon
                  return (
                    <span className="inline-flex items-center gap-1.5 text-[10px] text-foreground-subtle">
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      {meta.label}
                    </span>
                  )
                },
              },
              {
                // Action, RIGHT, mirroring the integration list's
                // right-aligned actions cell (`justify-end`). An adopted row has none.
                key: 'select',
                header: '',
                headerClassName: 'w-10 sm:w-[15%] text-right',
                cellClassName: 'text-right',
                cell: (item) => {
                  const state = adoptedStateOf(item, scan.added)
                  if (state.adopted) return null
                  const found = item.kind === 'found' ? item.row : item.found
                  const asksDetails =
                    found !== null && found.hit !== null && found.needsParams.length > 0
                  if (found !== null && (item.kind === 'found' || asksDetails)) {
                    return (
                      <div className="flex items-center justify-end">
                        <RowAddButton
                          row={found}
                          busy={scan.busy.has(found.key)}
                          devicesKnown={scan.devices === 'answered'}
                          onPick={scan.pick}
                        />
                      </div>
                    )
                  }
                  if (item.kind !== 'candidate') return null
                  const c = item.candidate
                  return (
                    <div className="flex items-center justify-end">
                      <Button
                        variant="unstyled"
                        onClick={() => toggleSelect(c)}
                        aria-label={
                          selected.has(c.childNativeId)
                            ? t('integrations.adoptDevicesModal.deselect', 'Deselect')
                            : t('integrations.adoptDevicesModal.select', 'Select')
                        }
                        className={`inline-flex h-5 w-5 items-center justify-center rounded border ${
                          selected.has(c.childNativeId)
                            ? 'border-primary bg-primary'
                            : 'border-border'
                        }`}
                      >
                        {selected.has(c.childNativeId) && (
                          <Check className="h-3 w-3 text-primary-foreground" />
                        )}
                      </Button>
                    </div>
                  )
                },
              },
            ]}
            isExpanded={(item) =>
              !isFlatFilter &&
              item.kind === 'candidate' &&
              expanded.has(item.candidate.childNativeId)
            }
            renderExpanded={
              isFlatFilter
                ? undefined
                : (item) =>
                    item.kind === 'candidate' ? (
                      <CandidateEntities
                        candidate={item.candidate}
                        hiddenChildIds={
                          overrides.get(item.candidate.childNativeId)?.hiddenChildIds ?? new Set()
                        }
                        onToggleChildHidden={(childId) =>
                          toggleChildHidden(item.candidate.childNativeId, childId)
                        }
                      />
                    ) : null
            }
            rowClassName={(item) =>
              adoptedStateOf(item, scan.added).adopted
                ? 'opacity-60'
                : item.kind === 'candidate' && selected.has(item.candidate.childNativeId)
                  ? 'bg-primary/5'
                  : ''
            }
          />
        </div>
      </div>

      {/* Error banner */}
      {submitError && (
        <div className="border-t border-danger/30 bg-danger/5 px-3 py-2 shrink-0">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-danger mt-0.5 shrink-0" />
            <p className="text-[11px] text-danger">{submitError}</p>
          </div>
        </div>
      )}

      {jobId !== null && (
        <AdoptJobProgress
          addonId={addonId}
          integrationId={integrationId}
          jobId={jobId}
          onFinished={onJobFinished}
        />
      )}

      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t('integrations.cancel', { defaultValue: 'Cancel' })}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={adoptionDone ? onClose : handleAdopt}
          disabled={!adoptionDone && (selectedCount === 0 || adoptMutation.isPending)}
        >
          {adoptMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {adoptionDone
            ? t('integrations.close', { defaultValue: 'Close' })
            : t('integrations.addSelected', { defaultValue: 'Add selected' })}
          {!adoptionDone && selectedCount > 0 ? ` (${selectedCount})` : ''}
        </Button>
      </DialogFooter>
    </>
  )
}

interface FilterSelectorProps {
  filters: readonly AdoptionFilter[]
  activeFilter: string
  onSelect: (filterId: string) => void
}

/**
 * Segmented control over the provider-declared discovery GRANULARITIES.
 * Rendered only when the provider declares more than one filter; switching
 * re-queries the candidate list at that granularity. Fully provider-agnostic —
 * each tab is just a `{id,label}` from the cap (no HA-specific branching).
 */
function FilterSelector({ filters, activeFilter, onSelect }: FilterSelectorProps) {
  const { t } = useTranslation()
  return (
    <div
      role="tablist"
      aria-label={t('integrations.adoptDevicesModal.discoveryGranularity', 'Discovery granularity')}
      className="inline-flex shrink-0 self-start rounded-lg border border-border bg-surface p-0.5"
    >
      {filters.map((filter) => {
        const active = filter.id === activeFilter
        return (
          <Button
            variant="unstyled"
            key={filter.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(filter.id)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              active
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover'
            }`}
          >
            {filter.label}
          </Button>
        )
      })}
    </div>
  )
}

export interface CandidateNameCellProps {
  candidate: DiscoveredChildDevice
  // Nesting level under a parent candidate (0 = top level).
  depth: number
  // The container the candidate sits under, named on a secondary line ("in <name>").
  containerName?: string
  // Whether the current granularity supports an expansion tree. Flat
  // granularities (entities) never render the chevron.
  expandable: boolean
  expanded: boolean
  onToggleExpand: () => void
  /** The hub already holds this device: it carries the Adopted mark and no add action. */
  adopted: boolean
  /** The hub device it is, to link to. */
  deviceId: number | null
  /** Leaves the modal before the device link navigates. */
  onNavigate: () => void
  // Device-type label, shown under the name on a phone (the Type column is hidden there).
  typeLabel: string
}

/**
 * Name cell for an adoption candidate, mirroring the integrations list's
 * `name` column (chevron-in-name-cell convention): a rounded hover chevron
 * (left) then the candidate name + adopted badge. The chevron only renders
 * when the candidate has entity-children to expand; its entity count rides
 * alongside it — candidate-specific affordance preserved.
 */
export function CandidateNameCell({
  candidate,
  depth,
  containerName,
  expandable,
  expanded,
  onToggleExpand,
  adopted,
  deviceId,
  onNavigate,
  typeLabel,
}: CandidateNameCellProps) {
  const { t } = useTranslation()
  const count = (candidate.children ?? []).length
  const distinguisher = candidateDistinguisher(candidate)
  return (
    <div className={`flex items-center gap-2.5 min-w-0 ${depth > 0 ? 'pl-5' : ''}`}>
      {expandable && count > 0 ? (
        <Button
          variant="unstyled"
          type="button"
          onClick={onToggleExpand}
          aria-label={
            expanded
              ? t('integrations.adoptDevicesModal.collapse', 'Collapse')
              : t('integrations.adoptDevicesModal.expand', 'Expand')
          }
          aria-expanded={expanded}
          className="flex h-5 flex-shrink-0 items-center justify-center gap-0.5 rounded px-0.5 text-[10px] text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          {count}
        </Button>
      ) : expandable ? (
        // Keeps names aligned with the rows that carry a chevron.
        <span className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground" data-testid="candidate-name">
          {candidate.name}
        </div>
        {/* Model and id tail: its own line, so it can never shorten the name. */}
        {distinguisher.length > 0 && (
          <div
            className="truncate text-[10px] text-foreground-subtle"
            data-testid="candidate-subtitle"
          >
            {distinguisher}
          </div>
        )}
        {containerName !== undefined && (
          <div
            className="truncate text-[10px] text-foreground-subtle"
            data-testid="candidate-container"
          >
            {t('integrations.adoptDevicesModal.inContainer', 'in {{name}}', {
              name: containerName,
            })}
          </div>
        )}
        {/* The Type column is hidden on a phone: its label rides under the name. */}
        <div className="truncate text-[10px] text-foreground-subtle sm:hidden">{typeLabel}</div>
      </div>
      {adopted && <AdoptedMark deviceId={deviceId} onNavigate={onNavigate} />}
    </div>
  )
}

interface FoundNameCellProps {
  readonly row: NetworkRow
  readonly adopted: boolean
  readonly deviceId: number | null
  readonly typeLabel: string
  readonly onNavigate: () => void
  /** Keeps the name aligned with the candidate rows that carry a chevron slot. */
  readonly alignWithChevron: boolean
}

/** Name cell of a device only the scan or passive discovery found: name, address, adopted mark. */
function FoundNameCell({
  row,
  adopted,
  deviceId,
  typeLabel,
  onNavigate,
  alignWithChevron,
}: FoundNameCellProps) {
  return (
    <div className="flex items-center gap-2.5 min-w-0" data-testid={`network-row-${row.key}`}>
      {alignWithChevron && <span className="h-5 w-5 flex-shrink-0" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground" data-testid="candidate-name">
          {row.name}
        </div>
        {row.address !== null && (
          <div className="truncate font-mono text-[10px] text-foreground-subtle">{row.address}</div>
        )}
        <div className="truncate text-[10px] text-foreground-subtle sm:hidden">{typeLabel}</div>
      </div>
      {adopted && (
        <AdoptedMark deviceId={deviceId} deviceName={row.addedName} onNavigate={onNavigate} />
      )}
    </div>
  )
}

interface CandidateEntitiesProps {
  candidate: DiscoveredChildDevice
  hiddenChildIds: ReadonlySet<string>
  onToggleChildHidden: (childId: string) => void
}

/**
 * Full-width expansion body for a candidate row: its entity-children, each
 * toggle-able to hide from the adopt. Rendered by <DeviceList>'s generic table
 * mode under the candidate's row when expanded.
 */
function CandidateEntities({
  candidate,
  hiddenChildIds,
  onToggleChildHidden,
}: CandidateEntitiesProps) {
  const { t } = useTranslation()
  const children = candidate.children ?? []
  if (children.length === 0) return null
  return (
    <div className="space-y-1 py-1">
      {children.map((child) => {
        const hidden = hiddenChildIds.has(child.childNativeId)
        const childCaps = child.capabilities ?? []
        return (
          <div
            key={child.childNativeId}
            className={`flex items-center gap-2 rounded px-2 py-1 ${hidden ? 'opacity-50' : ''}`}
          >
            <span className="text-[11px] text-foreground truncate flex-1 min-w-0">
              {child.name}
            </span>
            {childCaps.length > 0 && (
              <span className="text-[9px] text-foreground-subtle truncate">
                {childCaps.join(', ')}
              </span>
            )}
            <Button
              variant="unstyled"
              onClick={() => onToggleChildHidden(child.childNativeId)}
              aria-label={
                hidden
                  ? t('integrations.adoptDevicesModal.showChild', 'Show child')
                  : t('integrations.adoptDevicesModal.hideChild', 'Hide child')
              }
              title={
                hidden
                  ? t('integrations.adoptDevicesModal.showAfterAdopt', 'Show after adopt')
                  : t('integrations.adoptDevicesModal.hideAfterAdopt', 'Hide after adopt')
              }
              className="flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors flex-shrink-0"
            >
              {hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </Button>
          </div>
        )
      })}
    </div>
  )
}
