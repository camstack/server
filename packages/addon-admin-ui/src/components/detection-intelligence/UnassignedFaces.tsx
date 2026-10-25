/**
 * UnassignedFaces — view, select and manage recent detected face crops.
 *
 * - Coarse filter buttons: all / unassigned / recognized (server-side cap arg).
 * - Client-side narrowing (no cap params — ships addon-only): a date-range
 *   selector + a camera multi-select, applied over the fetched window.
 * - Each card shows the resolved camera NAME + a compact capture time.
 * - Clicking a card opens a zoomable detail panel (FaceDetailPanel).
 * - Multi-select: tick faces, then batch Assign / Detach / Delete.
 * - "Similar groups" opens SimilarGroupsModal, a full-size review of
 *   look-alike unassigned face clusters (large cards, per-member exclusion,
 *   re-analyze knobs, adopt / select-in-gallery).
 */

import {
  Button,
  EmptyState,
  MediaGrid,
  useDeviceManagerListAll,
  useFaceGalleryAssignFaces,
  useFaceGalleryDeleteFace,
  useFaceGalleryListIdentities,
  useFaceGalleryListRecentFaces,
  useFaceGalleryUnassignFace,
  useFaceGalleryUnassignFaces,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import {
  CheckSquare,
  ImageOff,
  Loader2,
  Sparkles,
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
import {
  countCroplessFaces,
  faceCropSrc,
  selectCroplessFaceIds,
} from '../../lib/face-gallery-selection.js'
import { usePagedList } from '../../lib/use-paged-list.js'
import { GalleryPager } from '../GalleryPager.js'
import { AssignDialog } from './AssignDialog.js'
import { CameraMultiSelect } from './CameraMultiSelect.js'
import { DateRangeFilter } from './DateRangeFilter.js'
import { FaceDetailPanel } from './FaceDetailPanel.js'
import { SimilarGroupsModal } from './SimilarGroupsModal.js'
import type { CameraOption, FaceInfo } from './types.js'
import { useTranslation } from 'react-i18next'

const FACE_GALLERY_KEY = [['faceGallery']]

// Fetch a generous window so client-side date/camera filtering has data to
// work over. If a deployment routinely exceeds this, a server-side filter
// (cap param) is the follow-up — see the module header.
const FETCH_LIMIT = 500

/** Cards per page in the faces grid (client-side pagination). */
const FACES_PAGE_SIZE = 120

type FilterMode = 'all' | 'unassigned' | 'recognized'

// ── Face card ───────────────────────────────────────────────────────────────

interface FaceCardProps {
  readonly face: FaceInfo
  readonly cameraName: string
  readonly nowMs: number
  readonly selected: boolean
  readonly onToggleSelect: (faceId: string) => void
  readonly onAssign: (faceId: string) => void
  readonly onOpenDetail: (faceId: string) => void
}

function FaceCard({
  face,
  cameraName,
  nowMs,
  selected,
  onToggleSelect,
  onAssign,
  onOpenDetail,
}: FaceCardProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const unassignFace = useFaceGalleryUnassignFace()
  const deleteFace = useFaceGalleryDeleteFace()

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: FACE_GALLERY_KEY })
  }
  const openDetail = () => onOpenDetail(face.faceId)

  // One resolver for every face-crop surface — see `faceCropSrc`. Prefers the
  // data-plane URL, falls back to the inline crop, null → "No crop".
  const cropSrc = faceCropSrc(face)

  return (
    <div
      className={`relative flex flex-col rounded-md border bg-surface overflow-hidden ${selected ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
    >
      <div className="aspect-square relative overflow-hidden bg-surface-hover">
        {cropSrc !== null ? (
          <img
            src={cropSrc}
            alt={t('detectionIntelligence.unassignedFaces.faceFrom', 'Face from {{cameraName}}', {
              cameraName,
            })}
            onClick={openDetail}
            loading="lazy"
            decoding="async"
            className="h-full w-full cursor-zoom-in object-cover"
          />
        ) : (
          <button // ui-check-ok: full-tile missing-crop hit target; Button chrome breaks the tile
            type="button"
            onClick={openDetail}
            className="flex h-full w-full flex-col items-center justify-center gap-1 bg-warning/5 text-foreground-subtle"
            title={t(
              'detectionIntelligence.unassignedFaces.noCropImageTheFace',
              "No crop image — the face's crop media is missing (a pre-fix orphan). Safe to delete.",
            )}
          >
            <ImageOff className="h-7 w-7 text-warning/70" />
            <span className="text-[9px] font-medium uppercase tracking-wide text-warning/80">
              {t('detectionIntelligence.unassignedFaces.noCrop', 'No crop')}
            </span>
          </button>
        )}

        {/* Select checkbox — always visible, always interactive. z-10 + a
            generous tap target; stopPropagation keeps a tick from also opening
            the detail. No overlay sits above it, so touch taps always land
            (the earlier overlay-eats-taps bug is gone with the hover overlay). */}
        <button // ui-check-ok: overlay select checkbox on media tile
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect(face.faceId)
          }}
          className="absolute left-0 top-0 z-10 rounded-br-md bg-black/50 p-1.5 text-white hover:bg-black/70"
          aria-label={
            selected
              ? t('detectionIntelligence.unassignedFaces.deselect', 'Deselect')
              : t('detectionIntelligence.unassignedFaces.select', 'Select')
          }
        >
          {selected ? (
            <CheckSquare className="h-4 w-4 text-primary" />
          ) : (
            <Square className="h-4 w-4" />
          )}
        </button>
      </div>

      <div className="min-w-0 px-2 pt-1.5 space-y-0.5">
        <p className="text-[10px] font-medium text-foreground truncate" title={cameraName}>
          {cameraName}
        </p>
        <p className="text-[10px] text-foreground-subtle truncate">
          {formatFaceTimestamp(face.timestamp, nowMs)}
        </p>
        <p
          className={`min-h-[0.875rem] truncate text-[10px] font-medium leading-tight ${
            face.identityName ? 'text-primary' : 'invisible'
          }`}
          title={face.identityName}
        >
          {face.identityName ?? '\u00a0'}
        </p>
      </div>

      {/* Persistent per-card action row — always visible, always tappable
          (no hover gate) so touch devices can act on a single face. Each button
          stopPropagations so it never also opens the detail. Buttons carry a
          ~32px tap target. */}
      <div className="mt-1 flex min-h-[2rem] items-center gap-0.5 border-t border-border/60 px-1 py-0.5">
        {face.assigned ? (
          <button // ui-check-ok: compact per-card icon action; IconButton sizes fight the row
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              unassignFace.mutate({ faceId: face.faceId }, { onSettled: invalidate })
            }}
            disabled={unassignFace.isPending}
            className="rounded p-1.5 text-foreground-subtle transition-colors hover:bg-warning/10 hover:text-warning disabled:opacity-40"
            aria-label={t('detectionIntelligence.unassignedFaces.detachFace', 'Detach face')}
            title={t('detectionIntelligence.unassignedFaces.detach', 'Detach')}
          >
            {unassignFace.isPending ? (
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
              onAssign(face.faceId)
            }}
            className="rounded p-1.5 text-foreground-subtle transition-colors hover:bg-primary/10 hover:text-primary"
            aria-label={t(
              'detectionIntelligence.unassignedFaces.assignFaceToPerson',
              'Assign face to person',
            )}
            title={t('detectionIntelligence.unassignedFaces.assignToPerson', 'Assign to person')}
          >
            <UserCheck className="h-4 w-4" />
          </button>
        )}
        <button // ui-check-ok: compact per-card icon action; IconButton sizes fight the row
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            deleteFace.mutate({ faceId: face.faceId }, { onSettled: invalidate })
          }}
          disabled={deleteFace.isPending}
          className="ml-auto rounded p-1.5 text-foreground-subtle transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
          aria-label={t('detectionIntelligence.unassignedFaces.deleteFace', 'Delete face')}
          title={t('detectionIntelligence.unassignedFaces.deleteFace', 'Delete face')}
        >
          {deleteFace.isPending ? (
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
  { labelKey: 'detectionIntelligence.unassignedFaces.filterUnassigned', value: 'unassigned' },
  { labelKey: 'detectionIntelligence.unassignedFaces.filterRecognized', value: 'recognized' },
]

export function UnassignedFaces() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<FilterMode>('all')
  const [dateRange, setDateRange] = useState<DateRange>(EMPTY_DATE_RANGE)
  const [selectedCameras, setSelectedCameras] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [assignTargets, setAssignTargets] = useState<readonly string[] | null>(null)
  const [similarOpen, setSimilarOpen] = useState(false)
  const [detailFaceId, setDetailFaceId] = useState<string | null>(null)

  // Fallback poll when the live face-gallery-changed subscription is
  // unavailable — see useFaceGalleryLiveRefresh (mounted by the DI page).
  //
  // `includeCrops: false` — every crop comes down as a `cropUrl` the browser
  // fetches, caches and ETags itself (see `faceCropSrc`). Measured on the live
  // hub for this exact 500-row page: 3,054,863 B → 271,899 B (11.2×, 2.65 MiB)
  // and 11.3 s → 0.15 s, because the inline path pays one store round-trip PLUS
  // a disk read PER ROW. That cost was paid again on every 30 s poll and after
  // every assign. Verified the same day that 0 of 500 live rows carried a
  // `base64` WITHOUT a `cropUrl`, so nothing loses its image; the single row
  // with neither renders the honest "No crop" placeholder, exactly as before.
  const { data: faces, isLoading } = useFaceGalleryListRecentFaces(
    { limit: FETCH_LIMIT, filter, includeCrops: false },
    { refetchInterval: 30_000 },
  )
  const { data: identities = [] } = useFaceGalleryListIdentities()
  // A face's `deviceId` is always a camera — cameras only, slim, and the query client's fleet window (D274) so this shares one fetch with the other
  // detection-intelligence sections instead of each re-triggering its own.
  const { data: devices } = useDeviceManagerListAll({
    isCamera: true,
    projection: 'slim',
  })

  const assignFaces = useFaceGalleryAssignFaces()
  const unassignFace = useFaceGalleryUnassignFace()
  const unassignFaces = useFaceGalleryUnassignFaces()
  const deleteFace = useFaceGalleryDeleteFace()

  const nowMs = Date.now()
  const rawList = (faces ?? []) as readonly FaceInfo[]

  // deviceId → display name resolver, from the device-manager device list.
  const nameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of devices ?? []) map.set(d.id, d.name)
    return map
  }, [devices])
  const cameraName = (deviceId: number): string =>
    nameById.get(deviceId) ?? t('detectionIntelligence.cameraFallback', { id: String(deviceId) })

  // Cameras present in the fetched faces, resolved + sorted by name.
  const cameraOptions = useMemo<readonly CameraOption[]>(() => {
    return distinctDeviceIds(rawList)
      .map((id) => ({ id, name: cameraName(id) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawList, nameById])

  // Client-side date + camera narrowing over the fetched window.
  const list = useMemo(() => {
    const byDate = filterFacesByDateRange(rawList, dateRange)
    return filterFacesByCameras(byDate, selectedCameras)
  }, [rawList, dateRange, selectedCameras])

  // Client-side pagination over the filtered list. Reset to page 1 whenever the
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
  const paged = usePagedList(list, FACES_PAGE_SIZE, pageResetKey)

  const byId = useMemo(() => new Map(rawList.map((f) => [f.faceId, f])), [rawList])
  const croplessCount = useMemo(() => countCroplessFaces(list), [list])
  const detailFace = detailFaceId !== null ? (byId.get(detailFaceId) ?? null) : null

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: FACE_GALLERY_KEY })
  }
  const clearSelection = () => setSelected(new Set())

  function toggleSelect(faceId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(faceId)) next.delete(faceId)
      else next.add(faceId)
      return next
    })
  }
  function selectMany(ids: readonly string[]) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
  }
  /** Select every VISIBLE face with no resolvable crop (orphans) so the action
   *  bar's Delete can purge them in one pass. Reuses the batch-delete path. */
  function selectCropless() {
    selectMany(selectCroplessFaceIds(list))
  }

  const selectedIds = [...selected]
  const batchPending = assignFaces.isPending || unassignFaces.isPending || deleteFace.isPending
  const detailPending = unassignFace.isPending || deleteFace.isPending

  function detachSelected() {
    if (selectedIds.length === 0) return
    unassignFaces.mutate(
      { faceIds: selectedIds },
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
    void Promise.allSettled(selectedIds.map((faceId) => deleteFace.mutateAsync({ faceId }))).then(
      () => {
        invalidate()
        clearSelection()
      },
    )
  }

  // Detail-panel single-face actions.
  function detailAssign(faceId: string) {
    setDetailFaceId(null)
    setAssignTargets([faceId])
  }
  function detailUnassign(faceId: string) {
    unassignFace.mutate({ faceId }, { onSettled: invalidate })
    setDetailFaceId(null)
  }
  function detailDelete(faceId: string) {
    deleteFace.mutate({ faceId }, { onSettled: invalidate })
    setDetailFaceId(null)
  }

  const isFiltered = list.length !== rawList.length

  return (
    <div className="relative space-y-3">
      {/* Filter bar + similar toggle */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button // ui-check-ok: CHIP_* face filter pill
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

        <button // ui-check-ok: CHIP_* similar-groups toggle in the filter bar
          type="button"
          onClick={() => setSimilarOpen(true)}
          className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors ${
            similarOpen
              ? 'bg-primary/12 text-primary font-medium'
              : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" />{' '}
          {t('detectionIntelligence.unassignedFaces.similarGroups')}
        </button>

        {!isLoading && croplessCount > 0 && (
          <button // ui-check-ok: CHIP_* bulk select for crop-less orphans
            type="button"
            onClick={selectCropless}
            className="ml-auto flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-warning/90 transition-colors hover:bg-warning/10"
            title={t(
              'detectionIntelligence.unassignedFaces.selectEveryVisibleFaceWhose',
              'Select every visible face whose crop image is missing so you can delete the orphans in one pass',
            )}
          >
            <ImageOff className="h-3.5 w-3.5" />{' '}
            {t('detectionIntelligence.unassignedFaces.selectCropless', { count: croplessCount })}
          </button>
        )}
        {!isLoading && (
          <span
            className={`text-[10px] text-foreground-subtle ${croplessCount > 0 ? 'ml-2' : 'ml-auto'}`}
          >
            {isFiltered
              ? t(
                  'detectionIntelligence.unassignedFaces.ofFaces',
                  '{{value1}} of {{value2}} faces',
                  { value1: String(list.length), value2: String(rawList.length) },
                )
              : t('detectionIntelligence.unassignedFaces.faceCount', { count: list.length })}
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
              {unassignFaces.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <UserX className="h-3.5 w-3.5" />
              )}{' '}
              {t('detectionIntelligence.unassignedFaces.detach', 'Detach')}
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

      {/* Loading / empty / grid — MediaGrid; face crops stay at 6.5rem tiles. */}
      {isLoading ? (
        <MediaGrid status="pending" pendingMessage="Loading faces…" testId="faces-grid" />
      ) : list.length === 0 ? (
        <EmptyState
          icon={ImageOff}
          title={
            rawList.length > 0
              ? t(
                  'detectionIntelligence.unassignedFaces.nothingMatchesTheFilter',
                  'Nothing matches the filter',
                )
              : t(
                  'detectionIntelligence.unassignedFaces.noFacesFoundForThis',
                  'No faces found for this filter',
                )
          }
          description={
            rawList.length > 0
              ? t(
                  'detectionIntelligence.unassignedFaces.widenTheDateRangeOr',
                  'Widen the date range or clear the camera filter.',
                )
              : t(
                  'detectionIntelligence.unassignedFaces.faceCropsAppearHereWhen',
                  'Face crops appear here when the detection pipeline captures them.',
                )
          }
        />
      ) : (
        <>
          <MediaGrid
            status="ready"
            testId="faces-grid"
            className="grid-cols-[repeat(auto-fill,minmax(6.5rem,6.5rem))] justify-start"
          >
            {paged.pageItems.map((face) => (
              <FaceCard
                key={face.faceId}
                face={face}
                cameraName={cameraName(face.deviceId)}
                nowMs={nowMs}
                selected={selected.has(face.faceId)}
                onToggleSelect={toggleSelect}
                onAssign={(id) => setAssignTargets([id])}
                onOpenDetail={setDetailFaceId}
              />
            ))}
          </MediaGrid>
          <GalleryPager
            currentPage={paged.page}
            totalItems={paged.totalItems}
            pageSize={paged.pageSize}
            onPageChange={paged.setPage}
            itemNoun="faces"
          />
        </>
      )}

      {/* Detail panel (zoomable enlarge + full metadata) */}
      <FaceDetailPanel
        face={detailFace}
        cameraName={detailFace ? cameraName(detailFace.deviceId) : ''}
        onClose={() => setDetailFaceId(null)}
        onAssign={detailAssign}
        onUnassign={detailUnassign}
        onDelete={detailDelete}
        actionsPending={detailPending}
      />

      {/* Assign dialog (single or batch) */}
      <AssignDialog
        faceIds={assignTargets}
        identities={identities}
        onDone={() => {
          setAssignTargets(null)
          clearSelection()
        }}
      />

      {/* Similar (look-alike) groups modal */}
      <SimilarGroupsModal
        open={similarOpen}
        onClose={() => setSimilarOpen(false)}
        byId={byId}
        cameraName={cameraName}
        nowMs={nowMs}
        identities={identities}
        selectMany={selectMany}
      />
    </div>
  )
}
