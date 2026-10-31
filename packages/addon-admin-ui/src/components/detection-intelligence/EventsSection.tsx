/**
 * EventsSection — the Detection Intelligence "Events" grid.
 *
 * Lists every captured key event (one card per scored track) across all
 * cameras for a resolved time window, with client-side narrowing (camera
 * multi-select, class chips, a min-importance slider, importance/time sort)
 * over the per-camera `getKeyEvents` fan-out (`useKeyEventsFeed`, Task 7).
 * Live refresh is driven by `useEventsLiveRefresh` (Task 7); the pure merge /
 * sort / filter / group helpers live in `key-events-merge.ts` (Task 6).
 *
 * Batch delete is whole-track (fan-IN: one `deleteTracks` call per device via
 * `groupTrackIdsByDevice`). The delete UI is FEATURE-DETECTED: the generated
 * `usePipelineAnalyticsDeleteTracks` hook is `undefined` on a host ui-library
 * that predates the framework train, so the Delete button renders disabled
 * with an "arrives with the next update" tooltip until the cap router lands.
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Activity, ArrowDownWideNarrow, Clock, Loader2, Trash2, X } from 'lucide-react'
import {
  Button,
  EmptyState,
  MediaGrid,
  useAlert,
  useConfirm,
  useDeviceManagerListAll,
  usePipelineAnalyticsListEventKindsBatch,
  Slider,
} from '@camstack/ui-library'
import {
  filterKeyEvents,
  sortKeyEvents,
  groupTrackIdsByDevice,
  trackSelectionKey,
  resolveWindow,
  type KeyEventRow,
  type SortMode,
} from './key-events-merge.js'
import {
  DELETE_TRACKS_AVAILABLE,
  DELETE_UNAVAILABLE_TITLE,
  useDeleteTracksMutation,
} from './use-delete-tracks.js'
import { useKeyEventsFeed } from './use-key-events-feed.js'
import { useEventsLiveRefresh } from './use-events-live-refresh.js'
import { CameraMultiSelect } from './CameraMultiSelect.js'
import { EventKindFilter } from './EventKindFilter.js'
import { buildKindGroups } from './event-kind-vocabulary.js'
import { DateRangeFilter } from './DateRangeFilter.js'
import { EventDetailPanel } from './EventDetailPanel.js'
import { EventCard } from './EventCard.js'
import { GalleryPager } from '../GalleryPager.js'
import { usePagedList } from '../../lib/use-paged-list.js'
import { useScrolledPast } from '../../lib/use-scrolled-past.js'
import {
  distinctDeviceIds,
  EMPTY_DATE_RANGE,
  type DateRange,
} from '../../lib/face-gallery-filters.js'
import type { CameraOption } from './types.js'
import { useTranslation } from 'react-i18next'

const EVENTS_FEED_KEY = ['events-feed']

/** Cards per page in the events grid (client-side pagination). */
const EVENTS_PAGE_SIZE = 60

// ── Main export ───────────────────────────────────────────────────────────────

const SORTS: readonly {
  readonly value: SortMode
  readonly labelKey: string
  readonly icon: typeof Clock
}[] = [
  {
    value: 'importance',
    labelKey: 'detectionIntelligence.eventsSection.sortImportance',
    icon: ArrowDownWideNarrow,
  },
  { value: 'time', labelKey: 'detectionIntelligence.eventsSection.sortRecent', icon: Clock },
]

export function EventsSection(): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const showAlert = useAlert()
  const confirm = useConfirm()

  const [dateRange, setDateRange] = useState<DateRange>(EMPTY_DATE_RANGE)
  const [selectedCameras, setSelectedCameras] = useState<Set<number>>(new Set())
  const [classFilter, setClassFilter] = useState<Set<string>>(new Set())
  const [minImportance, setMinImportance] = useState(0)
  const [sortMode, setSortMode] = useState<SortMode>('time')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detailRow, setDetailRow] = useState<KeyEventRow | null>(null)

  // Coarse clock tick (60s) so the resolved window + relative timestamps are
  // stable across renders (a fresh Date.now() every render would churn the
  // per-device feed query keys).
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const { since, until } = useMemo(
    () => resolveWindow({ fromMs: dateRange.fromMs, toMs: dateRange.toMs }, nowMs),
    [dateRange.fromMs, dateRange.toMs, nowMs],
  )

  // Live refresh, held back while the operator is using the list. The feed is
  // time-sorted, so an invalidation that lands mid-read reorders the grid: new
  // events enter at the top and the card being examined moves down.
  //
  // "Busy" is any of three things, and all three were reported as the same
  // complaint — the page moves while I am looking at something:
  //   - a detail panel is open
  //   - a multi-select is in progress (a reorder makes the selection meaningless)
  //   - they have scrolled into the grid, so new rows above would shift it
  //
  // At the top of the feed with nothing selected, live updates flow as before —
  // that is when arriving events are the thing you came to see.
  const feedTop = useScrolledPast()
  const busy = detailRow !== null || selected.size > 0 || feedTop.scrolledPast
  const { pending: refreshPending, refreshNow } = useEventsLiveRefresh({
    paused: busy,
  })

  // Cameras only, filtered server-side (`isCamera: true`) rather than
  // fetching the whole smart-home (sensors, switches, …) and discarding
  // non-cameras client side — else the feed fans getKeyEvents across
  // hundreds of non-camera devices and the camera dropdown lists everything.
  // `slim` + the query client's fleet window (D274): same camera-roster shape the other
  // detection-intelligence sections read, so they share one fetch.
  const { data: devices = [] } = useDeviceManagerListAll({
    isCamera: true,
    projection: 'slim',
  })
  const deviceIds = useMemo(() => devices.map((d) => d.id), [devices])

  // The kinds menu is DERIVED from what the cameras actually advertise, not
  // from the static taxonomy dictionary: on this cluster the per-camera
  // vocabularies run from 1 kind to 53, so a dictionary-built menu described no
  // camera. One batched call for every camera — the per-device answers are
  // narrowed client-side as the camera selection changes, so switching cameras
  // costs no round-trip.
  const { data: eventKindsPerDevice, isLoading: kindsLoading } =
    usePipelineAnalyticsListEventKindsBatch(
      { deviceIds },
      { enabled: deviceIds.length > 0, staleTime: 5 * 60_000 },
    )

  const kindGroups = useMemo(
    () => buildKindGroups(eventKindsPerDevice ?? [], selectedCameras),
    [eventKindsPerDevice, selectedCameras],
  )

  const deleteMutation = useDeleteTracksMutation()
  const deletePending = deleteMutation.isPending

  const { rows, isLoading } = useKeyEventsFeed({
    deviceIds,
    since,
    until,
    minImportance: minImportance > 0 ? minImportance : undefined,
    classFilter: classFilter.size === 1 ? [...classFilter][0] : undefined,
  })

  // deviceId → display name resolver, from the device-manager device list.
  const nameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of devices ?? []) map.set(d.id, d.name)
    return map
  }, [devices])
  const cameraName = (deviceId: number): string =>
    nameById.get(deviceId) ?? t('detectionIntelligence.cameraFallback', { id: String(deviceId) })

  // Cameras present in the fetched rows, resolved + sorted by name.
  const cameraOptions = useMemo<readonly CameraOption[]>(() => {
    return distinctDeviceIds(rows)
      .map((id) => ({ id, name: cameraName(id) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, nameById])

  const list = useMemo(
    () =>
      sortKeyEvents(
        filterKeyEvents(rows, {
          cameras: selectedCameras,
          classes: classFilter,
          minImportance,
        }),
        sortMode,
      ),
    [rows, selectedCameras, classFilter, minImportance, sortMode],
  )

  // Client-side pagination over the filtered+sorted list. Reset to page 1
  // whenever the narrowing/sort signature changes.
  const pageResetKey = useMemo(
    () =>
      JSON.stringify([
        [...selectedCameras].sort((a, b) => a - b),
        [...classFilter].sort(),
        minImportance,
        sortMode,
        since,
        until,
      ]),
    [selectedCameras, classFilter, minImportance, sortMode, since, until],
  )
  const paged = usePagedList(list, EVENTS_PAGE_SIZE, pageResetKey)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: EVENTS_FEED_KEY })
  }
  const clearSelection = () => setSelected(new Set())

  function toggleSelect(selectionKey: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(selectionKey)) next.delete(selectionKey)
      else next.add(selectionKey)
      return next
    })
  }

  function deleteSelected() {
    if (selected.size === 0 || !DELETE_TRACKS_AVAILABLE) return
    const grouped = groupTrackIdsByDevice(rows, selected)
    const total = [...grouped.values()].reduce((n, ids) => n + ids.length, 0)
    if (total === 0) return
    void (async () => {
      const ok = await confirm({
        title: t('detectionIntelligence.eventsSection.deleteTitle', { count: total }),
        message: t('detectionIntelligence.eventsSection.deleteMessage', { count: total }),
        confirmLabel: t('common.delete', 'Delete'),
        variant: 'danger',
      })
      if (ok) runDeleteSelected(grouped)
    })()
  }

  /** The fan-IN itself, once the operator has agreed to it. */
  function runDeleteSelected(grouped: Map<number, string[]>) {
    // One delete call per device (fan-IN). Some may fail — surface the rejected
    // cameras and clear selection ONLY for the tracks that were actually deleted.
    const entries = [...grouped]
    void Promise.allSettled(
      entries.map(([deviceId, trackIds]) => deleteMutation.mutateAsync({ deviceId, trackIds })),
    ).then((results) => {
      invalidate()
      const failedDeviceIds: number[] = []
      const succeededKeys = new Set<string>()
      results.forEach((res, i) => {
        const entry = entries[i]
        if (!entry) return
        const [deviceId, trackIds] = entry
        if (res.status === 'fulfilled') {
          for (const trackId of trackIds) succeededKeys.add(trackSelectionKey(deviceId, trackId))
        } else {
          failedDeviceIds.push(deviceId)
        }
      })
      // Keep failed selections so the operator can retry them.
      setSelected((prev) => {
        const next = new Set(prev)
        for (const key of succeededKeys) next.delete(key)
        return next
      })
      if (failedDeviceIds.length > 0) {
        const names = failedDeviceIds.map((id) => cameraName(id)).join(', ')
        void showAlert({
          title: t(
            'detectionIntelligence.eventsSection.someTracksWereNotDeleted',
            'Some tracks were not deleted',
          ),
          message: t(
            'detectionIntelligence.eventsSection.failedToDeleteTracksOn',
            'Failed to delete tracks on: {{names}}. They remain selected — retry, or check the server logs.',
            { names },
          ),
          variant: 'danger',
        })
      }
    })
  }

  const isFiltered = list.length !== rows.length

  return (
    <div className="relative space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-1.5">
        <DateRangeFilter onChange={setDateRange} />
        <CameraMultiSelect
          cameras={cameraOptions}
          selected={selectedCameras}
          onChange={setSelectedCameras}
        />

        {/* Hierarchical event-kind filter (macro → sub, taxonomy-driven) */}
        <EventKindFilter
          groups={kindGroups}
          selected={classFilter}
          onChange={setClassFilter}
          loading={kindsLoading}
        />

        {/* Min-importance slider */}
        <label className="flex items-center gap-1.5 text-[11px] text-foreground-subtle">
          <span>{t('detectionIntelligence.eventsSection.minScore', 'Min score')}</span>
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={minImportance}
            onChange={(e) => setMinImportance(Number(e.target.value))}
            className="h-1 w-24 cursor-pointer accent-primary"
            aria-label={t(
              'detectionIntelligence.eventsSection.minimumImportance',
              'Minimum importance',
            )}
          />
          <span className="w-6 tabular-nums text-foreground">
            {Math.round(minImportance * 100)}
          </span>
        </label>

        {/* Sort toggle */}
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          {SORTS.map((s) => {
            const Icon = s.icon
            return (
              <button // ui-check-ok: CHIP_* sort segment; Button chrome breaks the bar
                key={s.value}
                type="button"
                onClick={() => setSortMode(s.value)}
                className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors ${
                  sortMode === s.value
                    ? 'bg-primary/12 text-primary font-medium'
                    : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
                }`}
              >
                <Icon className="h-3.5 w-3.5" /> {t(s.labelKey)}
              </button>
            )
          })}
        </div>

        {!isLoading && (
          <span className="ml-auto text-[10px] text-foreground-subtle">
            {isFiltered
              ? t(
                  'detectionIntelligence.eventsSection.ofEvents',
                  '{{value1}} of {{value2}} events',
                  { value1: String(list.length), value2: String(rows.length) },
                )
              : t('detectionIntelligence.eventsSection.eventCount', { count: list.length })}
          </span>
        )}
      </div>

      {/* Selection action bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/8 px-3 py-2">
          <span className="text-xs font-medium text-foreground">
            {t('common.selectedCount', { count: selected.size })}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span title={DELETE_TRACKS_AVAILABLE ? undefined : DELETE_UNAVAILABLE_TITLE}>
              <Button
                variant="secondary"
                onClick={deleteSelected}
                disabled={!DELETE_TRACKS_AVAILABLE || deletePending}
              >
                {deletePending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}{' '}
                {t('common.delete', 'Delete')}
              </Button>
            </span>
            <Button variant="ghost" onClick={clearSelection} disabled={deletePending}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Owed-refresh affordance. Sticky so it is reachable from anywhere in a
          long grid — the operator who has scrolled down is exactly the one whose
          refresh is being held back. `top-2` clears the page's own header. */}
      {refreshPending && (
        <div className="sticky top-2 z-20 flex justify-center">
          <button // ui-check-ok: sticky live-refresh pill; Button sizes fight the float
            type="button"
            onClick={refreshNow}
            className="rounded-full border border-primary/40 bg-surface px-3 py-1 text-[11px] font-medium text-primary shadow-sm hover:bg-primary/10"
          >
            {t('detectionIntelligence.eventsSection.newEventsRefresh', 'New events — refresh')}
          </button>
        </div>
      )}

      {isLoading ? (
        <MediaGrid status="pending" pendingMessage="Loading events…" testId="events-grid" />
      ) : list.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={
            isFiltered
              ? t(
                  'detectionIntelligence.eventsSection.nothingMatchesTheFilter',
                  'Nothing matches the filter',
                )
              : t(
                  'detectionIntelligence.eventsSection.noKeyEventsInThis',
                  'No key events in this window',
                )
          }
          description={
            isFiltered
              ? t(
                  'detectionIntelligence.eventsSection.widenTheDateRangeClear',
                  'Widen the date range, clear cameras or kinds, or lower the min score.',
                )
              : t(
                  'detectionIntelligence.eventsSection.capturedTracksAppearHereWhen',
                  'Captured tracks appear here when the pipeline scores a key event.',
                )
          }
        />
      ) : (
        <>
          {/* Zero-height sentinel: while it is on screen the operator is at the
              top of the grid and live refreshes apply immediately. */}
          <div ref={feedTop.ref} aria-hidden className="h-0" />
          <MediaGrid status="ready" testId="events-grid">
            {paged.pageItems.map((row) => (
              <EventCard
                key={trackSelectionKey(row.deviceId, row.trackId)}
                row={row}
                cameraName={cameraName(row.deviceId)}
                nowMs={nowMs}
                selected={selected.has(trackSelectionKey(row.deviceId, row.trackId))}
                onToggleSelect={toggleSelect}
                onOpenDetail={setDetailRow}
              />
            ))}
          </MediaGrid>
          <GalleryPager
            currentPage={paged.page}
            totalItems={paged.totalItems}
            pageSize={paged.pageSize}
            onPageChange={paged.setPage}
            itemNoun="events"
          />
        </>
      )}

      {/* Detail modal */}
      {detailRow && (
        <EventDetailPanel
          row={detailRow}
          cameraName={cameraName(detailRow.deviceId)}
          deleteAvailable={DELETE_TRACKS_AVAILABLE}
          onClose={() => setDetailRow(null)}
          onDeleted={() => {
            invalidate()
            setDetailRow(null)
          }}
          onFlagsChanged={(flags) => {
            // Patch the open row in place instead of invalidating: an
            // invalidation here would refetch every camera's feed and re-sort
            // the grid under the operator mid-read, which is the exact
            // behaviour `useEventsLiveRefresh({ paused })` exists to prevent.
            // The next natural refetch carries the server value anyway.
            setDetailRow((current) =>
              current && current.trackId === flags.trackId
                ? {
                    ...current,
                    markForTrain: flags.markForTrain,
                    debug: flags.debug,
                    favourited: flags.favourited,
                  }
                : current,
            )
          }}
        />
      )}
    </div>
  )
}
