/**
 * RecentPlates — view, select and manage recent recognized license-plate reads.
 *
 * Mirrors the faces `UnassignedFaces`, adapted for the plate domain:
 * - Coarse filter buttons: all / unassigned / assigned. `listPlates` takes NO
 *   server-side filter arg (only `deviceId`/`limit`), so the mode is applied
 *   CLIENT-side over the `assigned` flag — unlike faces where `filter` is a cap
 *   param.
 * - Client-side narrowing: a date-range selector + a camera multi-select over
 *   the fetched window (reuses the shared face-gallery filter helpers, which are
 *   generic over `{ timestamp }` / `{ deviceId }`).
 * - Each card shows the OCR text prominently, the resolved camera NAME, and a
 *   compact capture time.
 * - Clicking a card opens a zoomable detail panel (`PlateDetailPanel`).
 * - Multi-select: tick plates, then batch Assign / Detach / Delete.
 */

import {
  Button,
  EmptyState,
  MediaGrid,
  useDeviceManagerListAll,
  usePlateGalleryDeletePlate,
  usePlateGalleryListPlates,
  usePlateGalleryListVehicles,
  usePlateGalleryUnassignPlate,
  usePlateGalleryUnassignPlates,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import {
  BadgeCheck,
  CheckSquare,
  ImageOff,
  Loader2,
  Square,
  Trash2,
  UserCheck,
  UserX,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  type DateRange,
  distinctDeviceIds,
  EMPTY_DATE_RANGE,
  filterFacesByCameras,
  filterFacesByDateRange,
  formatFaceTimestamp,
} from '../../lib/face-gallery-filters.js'
import { plateCropSrc } from '../../lib/plate-crop-src.js'
import { usePagedList } from '../../lib/use-paged-list.js'
import { GalleryPager } from '../GalleryPager.js'
import { AssignPlateDialog } from './AssignPlateDialog.js'
import { CameraMultiSelect } from './CameraMultiSelect.js'
import { DateRangeFilter } from './DateRangeFilter.js'
import { PlateDetailPanel } from './PlateDetailPanel.js'
import type { PlateInfo } from './plate-types.js'
import type { CameraOption } from './types.js'
import { useTranslation } from 'react-i18next'

const PLATE_GALLERY_KEY = [['plateGallery']]

// Fetch a generous window so client-side date/camera/mode filtering has data to
// work over. A deployment routinely exceeding this needs a server-side filter.
const FETCH_LIMIT = 500

/** Cards per page in the plates grid (client-side pagination). */
const PLATES_PAGE_SIZE = 120

type FilterMode = 'all' | 'unassigned' | 'assigned'

// ── Plate card ─────────────────────────────────────────────────────────────

interface PlateCardProps {
  readonly plate: PlateInfo
  readonly cameraName: string
  readonly nowMs: number
  readonly selected: boolean
  readonly onToggleSelect: (plateId: string) => void
  readonly onAssign: (plateId: string) => void
  readonly onOpenDetail: (plateId: string) => void
}

function PlateCard({
  plate,
  cameraName,
  nowMs,
  selected,
  onToggleSelect,
  onAssign,
  onOpenDetail,
}: PlateCardProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const unassignPlate = usePlateGalleryUnassignPlate()
  const deletePlate = usePlateGalleryDeletePlate()

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: PLATE_GALLERY_KEY })
  }
  const openDetail = () => onOpenDetail(plate.plateId)

  const cropSrc = plateCropSrc(plate)

  return (
    <div
      className={`relative flex flex-col overflow-hidden rounded-md border bg-surface ${selected ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
    >
      <div className="relative aspect-[2/1] overflow-hidden bg-surface-hover">
        {cropSrc !== null ? (
          <img
            src={cropSrc}
            alt={t(
              'detectionIntelligence.recentPlates.plateFrom',
              'Plate {{text}} from {{cameraName}}',
              { text: plate.text, cameraName },
            )}
            onClick={openDetail}
            className="h-full w-full cursor-zoom-in object-cover"
          />
        ) : (
          <button // ui-check-ok: full-tile missing-crop hit target; Button chrome breaks the tile
            type="button"
            onClick={openDetail}
            className="flex h-full w-full flex-col items-center justify-center gap-1 bg-warning/5 text-foreground-subtle"
            title={t(
              'detectionIntelligence.recentPlates.noCropImageThePlate',
              "No crop image — the plate's crop media is missing. Safe to delete.",
            )}
          >
            <ImageOff className="h-7 w-7 text-warning/70" />
            <span className="text-[9px] font-medium uppercase tracking-wide text-warning/80">
              {t('detectionIntelligence.recentPlates.noCrop', 'No crop')}
            </span>
          </button>
        )}

        {/* Select checkbox — always visible, always interactive. */}
        <button // ui-check-ok: overlay select checkbox on media tile
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect(plate.plateId)
          }}
          className="absolute left-0 top-0 z-10 rounded-br-md bg-black/50 p-1.5 text-white hover:bg-black/70"
          aria-label={
            selected
              ? t('detectionIntelligence.recentPlates.deselect', 'Deselect')
              : t('detectionIntelligence.recentPlates.select', 'Select')
          }
        >
          {selected ? (
            <CheckSquare className="h-4 w-4 text-primary" />
          ) : (
            <Square className="h-4 w-4" />
          )}
        </button>

        {/* Corrected badge */}
        {plate.corrected && (
          <span
            className="absolute right-0 top-0 z-10 flex items-center gap-0.5 rounded-bl-md bg-primary/80 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-white"
            title={t('detectionIntelligence.recentPlates.manuallyCorrected', 'Manually corrected')}
          >
            <BadgeCheck className="h-3 w-3" /> {t('detectionIntelligence.recentPlates.fixed')}
          </span>
        )}
      </div>

      {/* Read text + camera + time */}
      <div className="min-w-0 px-2 pt-1.5 space-y-0.5">
        <p
          className="truncate font-mono text-xs font-bold tracking-wide text-foreground"
          title={plate.text}
        >
          {plate.text || '—'}
        </p>
        <p className="truncate text-[10px] text-foreground-subtle" title={cameraName}>
          {cameraName}
        </p>
        <p className="truncate text-[10px] text-foreground-subtle">
          {formatFaceTimestamp(plate.timestamp, nowMs)}
        </p>
        {plate.vehicleName && (
          <p className="truncate text-[10px] font-medium text-primary" title={plate.vehicleName}>
            {plate.vehicleName}
          </p>
        )}
      </div>

      {/* Persistent per-card action row */}
      <div className="mt-1 flex items-center gap-0.5 border-t border-border/60 px-1 py-0.5">
        {plate.assigned ? (
          <button // ui-check-ok: compact per-card icon action; IconButton sizes fight the row
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              unassignPlate.mutate({ plateId: plate.plateId }, { onSettled: invalidate })
            }}
            disabled={unassignPlate.isPending}
            className="rounded p-1.5 text-foreground-subtle transition-colors hover:bg-warning/10 hover:text-warning disabled:opacity-40"
            aria-label={t('detectionIntelligence.recentPlates.detachPlate', 'Detach plate')}
            title={t('detectionIntelligence.recentPlates.detach', 'Detach')}
          >
            {unassignPlate.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UserX className="h-4 w-4" />
            )}
          </button>
        ) : (
          <button // ui-check-ok: compact per-card icon action; IconButton sizes fight the row
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onAssign(plate.plateId)
            }}
            className="rounded p-1.5 text-foreground-subtle transition-colors hover:bg-primary/10 hover:text-primary"
            aria-label={t(
              'detectionIntelligence.recentPlates.assignPlateToVehicle',
              'Assign plate to vehicle',
            )}
            title={t('detectionIntelligence.recentPlates.assignToVehicle', 'Assign to vehicle')}
          >
            <UserCheck className="h-4 w-4" />
          </button>
        )}
        <button // ui-check-ok: compact per-card icon action; IconButton sizes fight the row
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            deletePlate.mutate({ plateId: plate.plateId }, { onSettled: invalidate })
          }}
          disabled={deletePlate.isPending}
          className="ml-auto rounded p-1.5 text-foreground-subtle transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
          aria-label={t('detectionIntelligence.recentPlates.deletePlate', 'Delete plate')}
          title={t('detectionIntelligence.recentPlates.deletePlate', 'Delete plate')}
        >
          {deletePlate.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

const FILTERS: { labelKey: string; value: FilterMode }[] = [
  { labelKey: 'common.all', value: 'all' },
  { labelKey: 'detectionIntelligence.recentPlates.filterUnassigned', value: 'unassigned' },
  { labelKey: 'detectionIntelligence.recentPlates.filterAssigned', value: 'assigned' },
]

/** Client-side mode narrowing over the `assigned` flag. */
function filterPlatesByMode(plates: readonly PlateInfo[], mode: FilterMode): readonly PlateInfo[] {
  if (mode === 'unassigned') return plates.filter((p) => !p.assigned)
  if (mode === 'assigned') return plates.filter((p) => p.assigned)
  return plates
}

export function RecentPlates() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<FilterMode>('all')
  const [dateRange, setDateRange] = useState<DateRange>(EMPTY_DATE_RANGE)
  const [selectedCameras, setSelectedCameras] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [assignTargets, setAssignTargets] = useState<readonly string[] | null>(null)
  const [detailPlateId, setDetailPlateId] = useState<string | null>(null)

  // Fallback poll when the live plate-gallery-changed subscription is
  // unavailable — see usePlateGalleryLiveRefresh (mounted by the Plates page).
  //
  // `includeCrops: false` — every crop comes down as a `cropUrl` the browser
  // fetches, caches and ETags itself (see `plateCropSrc`). Measured on the live
  // hub for this exact 500-row page: 879,403 B and 27.7 s with the crops
  // inline, and that cost was paid again on every 30 s poll and after every
  // assign. This is the same change the faces gallery already shipped; plates
  // were the one gallery list still without the opt-out.
  const { data: plates, isLoading } = usePlateGalleryListPlates(
    { limit: FETCH_LIMIT, includeCrops: false },
    { refetchInterval: 30_000 },
  )
  const { data: vehicles = [] } = usePlateGalleryListVehicles()
  // A plate's `deviceId` is always a camera — cameras only, slim, and the query client's fleet window (D274) so this shares one fetch with the other
  // detection-intelligence sections instead of each re-triggering its own.
  const { data: devices } = useDeviceManagerListAll({
    isCamera: true,
    projection: 'slim',
  })

  const unassignPlate = usePlateGalleryUnassignPlate()
  const unassignPlates = usePlateGalleryUnassignPlates()
  const deletePlate = usePlateGalleryDeletePlate()

  const nowMs = Date.now()
  const rawList: readonly PlateInfo[] = plates ?? []

  // deviceId → display name resolver, from the device-manager device list.
  const nameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of devices ?? []) map.set(d.id, d.name)
    return map
  }, [devices])
  const cameraName = (deviceId: number): string =>
    nameById.get(deviceId) ?? t('detectionIntelligence.cameraFallback', { id: String(deviceId) })

  // Cameras present in the fetched plates, resolved + sorted by name.
  const cameraOptions = useMemo<readonly CameraOption[]>(() => {
    return distinctDeviceIds(rawList)
      .map((id) => ({ id, name: cameraName(id) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawList, nameById])

  // Client-side mode + date + camera narrowing over the fetched window.
  const list = useMemo(() => {
    const byMode = filterPlatesByMode(rawList, filter)
    const byDate = filterFacesByDateRange(byMode, dateRange)
    return filterFacesByCameras(byDate, selectedCameras)
  }, [rawList, filter, dateRange, selectedCameras])

  // Client-side pagination over the filtered list. Reset to page 1 when the
  // filter/date/camera signature changes.
  const pageResetKey = useMemo(
    () =>
      JSON.stringify([
        filter,
        dateRange.fromMs,
        dateRange.toMs,
        [...selectedCameras].sort((a, b) => a - b),
      ]),
    [filter, dateRange.fromMs, dateRange.toMs, selectedCameras],
  )
  const paged = usePagedList(list, PLATES_PAGE_SIZE, pageResetKey)

  const byId = useMemo(() => new Map(rawList.map((p) => [p.plateId, p])), [rawList])
  const detailPlate = detailPlateId !== null ? (byId.get(detailPlateId) ?? null) : null

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: PLATE_GALLERY_KEY })
  }
  const clearSelection = () => setSelected(new Set())

  function toggleSelect(plateId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(plateId)) next.delete(plateId)
      else next.add(plateId)
      return next
    })
  }

  const selectedIds = [...selected]
  const batchPending = unassignPlates.isPending || deletePlate.isPending
  const detailPending = unassignPlate.isPending || deletePlate.isPending

  function detachSelected() {
    if (selectedIds.length === 0) return
    unassignPlates.mutate(
      { plateIds: selectedIds },
      {
        onSettled: () => {
          invalidate()
          clearSelection()
        },
      },
    )
  }
  function deleteSelected() {
    if (selectedIds.length === 0) return
    // No batch-delete cap method — fan out (small selections in practice).
    void Promise.allSettled(
      selectedIds.map((plateId) => deletePlate.mutateAsync({ plateId })),
    ).then(() => {
      invalidate()
      clearSelection()
    })
  }

  // Detail-panel single-plate actions.
  function detailAssign(plateId: string) {
    setDetailPlateId(null)
    setAssignTargets([plateId])
  }
  function detailUnassign(plateId: string) {
    unassignPlate.mutate({ plateId }, { onSettled: invalidate })
    setDetailPlateId(null)
  }
  function detailDelete(plateId: string) {
    deletePlate.mutate({ plateId }, { onSettled: invalidate })
    setDetailPlateId(null)
  }

  const isFiltered = list.length !== rawList.length

  return (
    <div className="relative space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button // ui-check-ok: CHIP_* assigned/unassigned filter pill
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                filter === f.value
                  ? 'bg-primary/12 text-primary font-medium'
                  : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
              }`}
            >
              {t(f.labelKey)}
            </button>
          ))}
        </div>

        <DateRangeFilter onChange={setDateRange} />
        <CameraMultiSelect
          cameras={cameraOptions}
          selected={selectedCameras}
          onChange={setSelectedCameras}
        />

        {!isLoading && (
          <span className="ml-auto text-[10px] text-foreground-subtle">
            {isFiltered
              ? t(
                  'detectionIntelligence.recentPlates.ofPlates',
                  '{{value1}} of {{value2}} plates',
                  { value1: String(list.length), value2: String(rawList.length) },
                )
              : t('detectionIntelligence.recentPlates.plateCount', { count: list.length })}
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
            <Button
              variant="primary"
              onClick={() => setAssignTargets(selectedIds)}
              disabled={batchPending}
            >
              <UserCheck className="h-3.5 w-3.5" /> {t('common.assign')}
            </Button>
            <Button variant="secondary" onClick={detachSelected} disabled={batchPending}>
              {unassignPlates.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <UserX className="h-3.5 w-3.5" />
              )}{' '}
              {t('detectionIntelligence.recentPlates.detach', 'Detach')}
            </Button>
            <Button variant="secondary" onClick={deleteSelected} disabled={batchPending}>
              <Trash2 className="h-3.5 w-3.5" /> {t('common.delete')}
            </Button>
            <Button variant="ghost" onClick={clearSelection} disabled={batchPending}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Loading / empty / grid — MediaGrid keeps pending ≠ empty (D315). */}
      {isLoading ? (
        <MediaGrid status="pending" pendingMessage="Loading plates…" testId="plates-grid" />
      ) : list.length === 0 ? (
        <EmptyState
          icon={ImageOff}
          title={
            rawList.length > 0
              ? t(
                  'detectionIntelligence.recentPlates.nothingMatchesTheFilter',
                  'Nothing matches the filter',
                )
              : t(
                  'detectionIntelligence.recentPlates.noPlatesRecognizedYet',
                  'No plates recognized yet',
                )
          }
          description={
            rawList.length > 0
              ? t(
                  'detectionIntelligence.recentPlates.widenTheDateRangeOr',
                  'Widen the date range or clear the camera filter.',
                )
              : t(
                  'detectionIntelligence.recentPlates.plateReadsAppearHereWhen',
                  'Plate reads appear here when the detection pipeline OCRs a vehicle.',
                )
          }
        />
      ) : (
        <>
          <MediaGrid status="ready" testId="plates-grid">
            {paged.pageItems.map((plate) => (
              <PlateCard
                key={plate.plateId}
                plate={plate}
                cameraName={cameraName(plate.deviceId)}
                nowMs={nowMs}
                selected={selected.has(plate.plateId)}
                onToggleSelect={toggleSelect}
                onAssign={(id) => setAssignTargets([id])}
                onOpenDetail={setDetailPlateId}
              />
            ))}
          </MediaGrid>
          <GalleryPager
            currentPage={paged.page}
            totalItems={paged.totalItems}
            pageSize={paged.pageSize}
            onPageChange={paged.setPage}
            itemNoun="plates"
          />
        </>
      )}

      {/* Detail panel (zoomable enlarge + full metadata + OCR correction) */}
      <PlateDetailPanel
        plate={detailPlate}
        cameraName={detailPlate ? cameraName(detailPlate.deviceId) : ''}
        onClose={() => setDetailPlateId(null)}
        onAssign={detailAssign}
        onUnassign={detailUnassign}
        onDelete={detailDelete}
        actionsPending={detailPending}
      />

      {/* Assign dialog (single or batch) */}
      <AssignPlateDialog
        plateIds={assignTargets}
        vehicles={vehicles}
        onDone={() => {
          setAssignTargets(null)
          clearSelection()
        }}
      />
    </div>
  )
}
