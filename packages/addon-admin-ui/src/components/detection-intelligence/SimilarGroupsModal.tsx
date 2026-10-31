/**
 * SimilarGroupsModal — full-size look-alike-group review over unassigned
 * faces. Replaces the old inline "Similar groups" panel (32px avatar stack,
 * hardcoded knobs, two actions).
 *
 * Clusters are EPHEMERAL suggestions (`suggestFaceClusters`) over unassigned
 * faces — there is no server-side "excluded" concept, so per-member exclusion
 * is purely client-side state (`cluster-exclusions.ts`) that trims the
 * faceIds set fed into Adopt / Select-in-gallery. Faces (crop, camera,
 * timestamp) are resolved from the `byId` map the parent already has loaded
 * via `listRecentFaces` — this component does not duplicate that query.
 *
 * Because the parent asks for `includeCrops: false`, those rows carry NO inline
 * `base64` — the crop is a `cropUrl`. Resolve every `<img src>` through
 * `faceCropSrc`, never off `base64` directly, or this whole modal renders as a
 * wall of "No crop".
 */

import {
  Button,
  Dialog,
  DialogContent,
  useConfirm,
  useFaceGalleryDeleteFace,
  useFaceGallerySuggestFaceClusters,
  Input,
  Slider,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { ImageOff, Loader2, RefreshCw, Sparkles, Trash2, Undo2, UserCheck, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { formatFaceTimestamp } from '../../lib/face-gallery-filters.js'
import { faceCropSrc } from '../../lib/face-gallery-selection.js'
import { AssignDialog } from './AssignDialog.js'
import {
  activeMembers,
  type ClusterView,
  toggleExclusion,
  visibleMembers,
} from './cluster-exclusions.js'
import type { FaceInfo, Identity } from './types.js'
import { ZoomableImage } from './ZoomableImage.js'
import { useTranslation } from 'react-i18next'

const FACE_GALLERY_KEY = [['faceGallery']]
const CLUSTER_LIMIT = 20

const THRESHOLD_MIN = 0.3
const THRESHOLD_MAX = 0.9
const THRESHOLD_STEP = 0.05
const THRESHOLD_DEFAULT = 0.5

const MIN_SIZE_MIN = 2
const MIN_SIZE_MAX = 10
const MIN_SIZE_DEFAULT = 2

interface SimilarGroupsModalProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly byId: ReadonlyMap<string, FaceInfo>
  readonly cameraName: (deviceId: number) => string
  readonly nowMs: number
  readonly identities: readonly Identity[]
  /** Adds ids to the parent's multi-select set (no dedupe needed — caller uses a Set). */
  readonly selectMany: (ids: readonly string[]) => void
}

// ── Rail item (shared between the desktop vertical rail and mobile strip) ──

interface RailItemProps {
  readonly cluster: ClusterView
  readonly face: FaceInfo | undefined
  readonly active: boolean
  readonly onSelect: () => void
}

function RailItem({ cluster, face, active, onSelect }: RailItemProps) {
  const { t } = useTranslation()
  const cropSrc = faceCropSrc(face)
  return (
    <Button
      variant="unstyled"
      type="button"
      onClick={onSelect}
      className={`flex shrink-0 flex-col items-center gap-1.5 rounded-md border p-2 text-center transition-colors md:w-full md:flex-row md:gap-2.5 md:text-left ${
        active ? 'border-primary bg-primary/8' : 'border-border bg-surface hover:bg-surface-hover'
      }`}
    >
      <div className="h-24 w-24 shrink-0 overflow-hidden rounded bg-surface-hover">
        {cropSrc !== null ? (
          <img
            src={cropSrc}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-24 w-24 object-cover"
          />
        ) : (
          <ImageOff className="h-24 w-24 p-6 text-foreground-subtle" />
        )}
      </div>
      <span className="w-24 text-[11px] leading-tight text-foreground-subtle md:w-auto">
        {t('detectionIntelligence.similarGroupsModal.clusterMeta', {
          count: cluster.size,
          percent: Math.round(cluster.cohesion * 100),
        })}
      </span>
    </Button>
  )
}

// ── Face card (grid) ────────────────────────────────────────────────────────

interface GroupFaceCardProps {
  readonly face: FaceInfo
  readonly cameraName: string
  readonly nowMs: number
  readonly excluded: boolean
  readonly onToggleExclude: () => void
  readonly onDelete: () => void
  readonly deletePending: boolean
}

function GroupFaceCard({
  face,
  cameraName,
  nowMs,
  excluded,
  onToggleExclude,
  onDelete,
  deletePending,
}: GroupFaceCardProps) {
  const { t } = useTranslation()
  const cropSrc = faceCropSrc(face)
  return (
    <div
      className={`relative flex flex-col rounded-md border bg-surface overflow-hidden transition-opacity ${
        excluded ? 'border-border opacity-40 grayscale' : 'border-border'
      }`}
    >
      <div className="aspect-square relative overflow-hidden bg-surface-hover">
        {cropSrc !== null ? (
          <ZoomableImage
            src={cropSrc}
            alt={t(
              'detectionIntelligence.similarGroupsModal.faceFrom',
              'Face from {{cameraName}}',
              { cameraName },
            )}
            className="h-full w-full"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-warning/5 text-foreground-subtle">
            <ImageOff className="h-7 w-7 text-warning/70" />
            <span className="text-[9px] font-medium uppercase tracking-wide text-warning/80">
              {t('detectionIntelligence.similarGroupsModal.noCrop', 'No crop')}
            </span>
          </div>
        )}

        <Button
          variant="unstyled"
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExclude()
          }}
          className="absolute right-1 top-1 z-10 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70"
          aria-label={
            excluded
              ? t('detectionIntelligence.similarGroupsModal.includeFace', 'Include face')
              : t('detectionIntelligence.similarGroupsModal.excludeFace', 'Exclude face')
          }
          title={
            excluded
              ? t('detectionIntelligence.similarGroupsModal.include', 'Include')
              : t('detectionIntelligence.similarGroupsModal.exclude', 'Exclude')
          }
        >
          {excluded ? <Undo2 className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
        </Button>
      </div>

      <div className="min-w-0 px-2 pt-1.5 space-y-0.5">
        <p className="text-[10px] font-medium text-foreground truncate" title={cameraName}>
          {cameraName}
        </p>
        <p className="text-[10px] text-foreground-subtle truncate">
          {formatFaceTimestamp(face.timestamp, nowMs)}
        </p>
      </div>

      <div className="mt-1 flex min-h-[2rem] items-center justify-end border-t border-border/60 px-1 py-0.5">
        <Button
          variant="unstyled"
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          disabled={deletePending}
          className="rounded p-1.5 text-foreground-subtle transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
          aria-label={t('detectionIntelligence.similarGroupsModal.deleteFace', 'Delete face')}
          title={t('detectionIntelligence.similarGroupsModal.deleteFace', 'Delete face')}
        >
          {deletePending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function SimilarGroupsModal({
  open,
  onClose,
  byId,
  cameraName,
  nowMs,
  identities,
  selectMany,
}: SimilarGroupsModalProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const deleteFace = useFaceGalleryDeleteFace()

  const [threshold, setThreshold] = useState(THRESHOLD_DEFAULT)
  const [minSize, setMinSize] = useState(MIN_SIZE_DEFAULT)
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null)
  const [excludedByCluster, setExcludedByCluster] = useState<
    Readonly<Record<string, ReadonlySet<string>>>
  >({})
  const [assignFaceIds, setAssignFaceIds] = useState<readonly string[] | null>(null)

  const {
    data: clusters,
    isFetching,
    refetch,
  } = useFaceGallerySuggestFaceClusters(
    { threshold, minClusterSize: minSize, limit: CLUSTER_LIMIT },
    { enabled: open },
  )
  // Type-boundary idiom: generated-hook output narrowed to the local named
  // interface (mirrors `(faces ?? []) as readonly FaceInfo[]` elsewhere in
  // this file family).
  const clusterList = (clusters ?? []) as readonly ClusterView[]

  // Exclusions are keyed by representativeFaceId and would otherwise survive
  // a re-query with different membership under the same representative —
  // clear them whenever the query re-runs with different knobs (the query
  // key already includes threshold/minSize, so it auto-refetches here; a
  // manual Re-analyze click is handled in the button's onClick below).
  useEffect(() => {
    setExcludedByCluster({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threshold, minSize])

  // Keep the selection valid as clusters load/refresh — default to the first
  // group, and fall back to the first when the selected one disappears
  // (adopted/re-analyzed away).
  useEffect(() => {
    if (clusterList.length === 0) {
      setSelectedClusterId(null)
      return
    }
    if (!clusterList.some((c) => c.representativeFaceId === selectedClusterId)) {
      setSelectedClusterId(clusterList[0]?.representativeFaceId ?? null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterList])

  const selectedCluster = useMemo(
    () => clusterList.find((c) => c.representativeFaceId === selectedClusterId) ?? null,
    [clusterList, selectedClusterId],
  )
  const excluded = selectedCluster
    ? (excludedByCluster[selectedCluster.representativeFaceId] ?? new Set<string>())
    : new Set<string>()

  // Members the operator can actually see (resolved via the parent's byId
  // map). A cluster can reference faceIds outside the parent's fetch window
  // or excluded by the active filter — those render no card below, so they
  // must never feed the action set (Finding 1: invisible members must not
  // be adoptable).
  const visibleMemberIds = useMemo(
    () => (selectedCluster ? visibleMembers(selectedCluster, (id) => byId.has(id)) : []),
    [selectedCluster, byId],
  )
  const hiddenCount = selectedCluster ? selectedCluster.faceIds.length - visibleMemberIds.length : 0
  const active = selectedCluster
    ? activeMembers({ ...selectedCluster, faceIds: visibleMemberIds }, excluded)
    : []

  function toggleExclude(faceId: string) {
    if (!selectedCluster) return
    const key = selectedCluster.representativeFaceId
    setExcludedByCluster((prev) => ({
      ...prev,
      [key]: toggleExclusion(prev[key] ?? new Set<string>(), faceId),
    }))
  }

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: FACE_GALLERY_KEY })
  }

  async function handleDelete(faceId: string) {
    const ok = await confirm({
      title: t('detectionIntelligence.similarGroupsModal.deleteFace', 'Delete face'),
      message: t(
        'detectionIntelligence.similarGroupsModal.permanentlyDeletesThisFaceCrop',
        'Permanently deletes this face crop. This cannot be undone.',
      ),
      confirmLabel: t('common.delete', 'Delete'),
      variant: 'danger',
    })
    if (!ok) return
    deleteFace.mutate({ faceId }, { onSettled: invalidate })
  }

  function handleClose() {
    setAssignFaceIds(null)
    onClose()
  }

  function selectInGallery() {
    if (active.length === 0) return
    selectMany(active)
    handleClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent
        placement="sheet-on-mobile"
        width="lg"
        aria-label={t(
          'detectionIntelligence.similarGroupsModal.lookAlikeGroups',
          'Look-alike groups',
        )}
        className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 md:max-w-4xl"
      >
        {/* Header — Close is the DialogContent built-in (pr-10 clears its hit area). */}
        <header className="flex shrink-0 flex-col gap-2 border-b border-border py-3 pl-4 pr-10">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Sparkles className="h-4 w-4 text-primary" />{' '}
            {t('detectionIntelligence.similarGroupsModal.title')}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2 text-[11px] text-foreground-subtle">
              {t('detectionIntelligence.similarGroupsModal.threshold', 'Threshold')}
              <Slider
                min={THRESHOLD_MIN}
                max={THRESHOLD_MAX}
                step={THRESHOLD_STEP}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                className="h-1.5 w-28 cursor-pointer accent-primary"
              />
              <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-foreground">
                {threshold.toFixed(2)}
              </span>
            </label>

            <label className="flex items-center gap-2 text-[11px] text-foreground-subtle">
              {t('detectionIntelligence.similarGroupsModal.minSize', 'Min size')}
              <Input
                type="number"
                min={MIN_SIZE_MIN}
                max={MIN_SIZE_MAX}
                step={1}
                value={minSize}
                onChange={(e) =>
                  setMinSize(
                    Math.min(
                      MIN_SIZE_MAX,
                      Math.max(MIN_SIZE_MIN, Number(e.target.value) || MIN_SIZE_MIN),
                    ),
                  )
                }
                className="w-12 rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground"
              />
            </label>

            <Button
              variant="secondary"
              onClick={() => {
                // Re-analyzing can change cluster membership under the same
                // representativeFaceId key — drop stale exclusions rather
                // than silently inheriting them (Finding 2).
                setExcludedByCluster({})
                void refetch()
              }}
              disabled={isFetching}
            >
              {isFetching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {t('detectionIntelligence.similarGroupsModal.reAnalyze', 'Re-analyze')}
            </Button>
          </div>
        </header>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-3 md:flex-row">
          {isFetching && clusterList.length === 0 ? (
            <div className="flex flex-1 items-center justify-center gap-2 py-8 text-xs text-foreground-subtle">
              <Loader2 className="h-4 w-4 animate-spin" />{' '}
              {t('detectionIntelligence.similarGroupsModal.finding')}
            </div>
          ) : clusterList.length === 0 ? (
            <div className="flex flex-1 items-center justify-center py-8 text-xs text-foreground-subtle">
              {t(
                'detectionIntelligence.similarGroupsModal.noLookAlikeGroupsAt',
                'No look-alike groups at this threshold.',
              )}
            </div>
          ) : (
            <>
              {/* Mobile: horizontal strip above the grid */}
              <div className="flex gap-2 overflow-x-auto pb-1 md:hidden">
                {clusterList.map((c) => (
                  <RailItem
                    key={c.representativeFaceId}
                    cluster={c}
                    face={byId.get(c.representativeFaceId)}
                    active={c.representativeFaceId === selectedClusterId}
                    onSelect={() => setSelectedClusterId(c.representativeFaceId)}
                  />
                ))}
              </div>

              {/* Desktop: left rail */}
              <div className="hidden shrink-0 flex-col gap-2 overflow-y-auto md:flex md:w-56">
                {clusterList.map((c) => (
                  <RailItem
                    key={c.representativeFaceId}
                    cluster={c}
                    face={byId.get(c.representativeFaceId)}
                    active={c.representativeFaceId === selectedClusterId}
                    onSelect={() => setSelectedClusterId(c.representativeFaceId)}
                  />
                ))}
              </div>

              {/* Main: selected cluster's faces */}
              <div className="min-h-0 flex-1 overflow-y-auto">
                {selectedCluster && (
                  <>
                    {hiddenCount > 0 && (
                      <p className="mb-2 text-[11px] text-foreground-subtle">
                        {t('detectionIntelligence.similarGroupsModal.hiddenCount', {
                          count: hiddenCount,
                        })}
                      </p>
                    )}
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,13rem))] justify-start gap-2">
                      {visibleMemberIds.map((faceId) => {
                        const face = byId.get(faceId)
                        if (!face) return null
                        return (
                          <GroupFaceCard
                            key={faceId}
                            face={face}
                            cameraName={cameraName(face.deviceId)}
                            nowMs={nowMs}
                            excluded={excluded.has(faceId)}
                            onToggleExclude={() => toggleExclude(faceId)}
                            onDelete={() => void handleDelete(faceId)}
                            deletePending={
                              deleteFace.isPending && deleteFace.variables?.faceId === faceId
                            }
                          />
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button variant="secondary" onClick={selectInGallery} disabled={active.length === 0}>
            {t('detectionIntelligence.similarGroupsModal.selectInGallery', 'Select in gallery')}
          </Button>
          <Button
            variant="primary"
            onClick={() => setAssignFaceIds(active)}
            disabled={active.length === 0}
          >
            <UserCheck className="h-3.5 w-3.5" />{' '}
            {t('detectionIntelligence.similarGroupsModal.adopt', { count: active.length })}
          </Button>
        </footer>
      </DialogContent>

      <AssignDialog
        faceIds={assignFaceIds}
        identities={identities}
        onDone={() => setAssignFaceIds(null)}
      />
    </Dialog>
  )
}
