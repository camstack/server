/**
 * PlateDetailPanel — enlarged, zoomable view of a single recognized plate read
 * plus its full metadata (camera, timestamp, track, OCR text/score, vehicle
 * assignment). Mirrors `FaceDetailPanel`.
 *
 * ## Why a top-layer Dialog
 * Same rationale as FaceDetailPanel: the gallery's own `relative` wrapper would
 * clip a slide-over, so this renders through the `Dialog` primitive whose native
 * `<dialog showModal()>` is promoted to the browser top layer — viewport-
 * anchored, never clipped. Centered card on desktop, full-width sheet on mobile.
 *
 * ## Image source (keyFrame adapter)
 * When the plate carries a `keyFrameMediaId` we fetch the native key frame off
 * the admin-gated event-media data-plane (`mediaIdPath`, Bearer-token-via-
 * fetch+blob, since `<img>` can't carry the header), read its natural
 * dimensions, and normalize the pixel `plateBbox` (`normalizeFaceBbox` — same
 * {x,y,w,h} pixel-box shape) into the overlay `ZoomableImage` expects. Frame
 * ⇄ Crop toggle drives it; crop stays the fallback whenever the id/media is
 * absent, still loading, or errored.
 *
 * ## OCR correction
 * The read's text is editable inline (self-labeling identity): `correctPlateText`
 * marks the row corrected + exempt from retention.
 */

import {
  Button,
  Dialog,
  DialogContent,
  Input,
  usePlateGalleryCorrectPlateText,
  usePlateGalleryGetPlateMedia,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Crop,
  ImageOff,
  Loader2,
  Pencil,
  Scan,
  Trash2,
  UserCheck,
  UserX,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { authedFetchBlob, mediaIdPath } from '../../lib/authed-media.js'
import { formatFaceTimestampFull } from '../../lib/face-gallery-filters.js'
import { plateCropSrc } from '../../lib/plate-crop-src.js'
import { normalizeFaceBbox } from './face-bbox.js'
import type { PlateInfo, PlateMediaFileLite } from './plate-types.js'
import type { NormalizedBox } from './types.js'
import { ZoomableImage } from './ZoomableImage.js'
import { useTranslation } from 'react-i18next'

const PLATE_GALLERY_KEY = [['plateGallery']]

interface KeyFrameAdapterResult {
  readonly frameSrc: string | null
  readonly naturalWidth: number | null
  readonly naturalHeight: number | null
  readonly failed: boolean
}

/**
 * Fetches the native key frame for `mediaId` (admin bearer auth via fetch),
 * exposes it as an object URL, and reads its natural pixel dimensions once
 * decoded. Re-runs on `mediaId` change; always revokes the previous URL.
 * Mirrors FaceDetailPanel's `useKeyFrameAdapter`.
 */
function useKeyFrameAdapter(mediaId: number | undefined): KeyFrameAdapterResult {
  const [frameSrc, setFrameSrc] = useState<string | null>(null)
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFrameSrc(null)
    setDims(null)
    setFailed(false)
    if (mediaId === undefined) return

    let cancelled = false
    let objectUrl: string | null = null

    void (async () => {
      try {
        const blob = await authedFetchBlob(mediaIdPath(mediaId))
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setFrameSrc(objectUrl)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [mediaId])

  useEffect(() => {
    if (!frameSrc) return
    const img = new Image()
    img.onload = () => setDims({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => setFailed(true)
    img.src = frameSrc
    return () => {
      img.onload = null
      img.onerror = null
    }
  }, [frameSrc])

  return {
    frameSrc,
    naturalWidth: dims?.width ?? null,
    naturalHeight: dims?.height ?? null,
    failed,
  }
}

interface PlateDetailPanelProps {
  readonly plate: PlateInfo | null
  readonly cameraName: string
  readonly onClose: () => void
  readonly onAssign: (plateId: string) => void
  readonly onUnassign: (plateId: string) => void
  readonly onDelete: (plateId: string) => void
  readonly actionsPending: boolean
}

type ImageMode = 'frame' | 'crop'

/**
 * Pick the crop-like media entry, else the first that is addressable.
 *
 * The gate is a non-empty URL, not non-empty bytes — see the identical note in
 * `FaceDetailPanel`. Keeping the old `m.base64.length > 0` here would have
 * returned null for every row once the rows stopped inlining, blanking the
 * crop on a panel whose bytes the hub was holding all along.
 */
function pickBestMedia(media: readonly PlateMediaFileLite[]): PlateMediaFileLite | null {
  const addressable = media.filter((m) => m.url.length > 0)
  if (addressable.length === 0) return null
  return addressable.find((m) => /crop|plate/i.test(m.kind)) ?? addressable[0]
}

function MetaRow({
  label,
  value,
  mono,
}: {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-border/60 last:border-0">
      <span className="shrink-0 text-[11px] uppercase tracking-wide text-foreground-subtle">
        {label}
      </span>
      <span
        className={`min-w-0 truncate text-right text-xs font-medium text-foreground ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

/** The plate rectangle painted over the full frame, in normalized coords. */
function PlateBoxOverlay({ box }: { readonly box: NormalizedBox }) {
  const { t } = useTranslation()
  return (
    <div
      className="pointer-events-none absolute rounded-[3px] border-2 border-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]"
      style={{
        left: `${String(box.x * 100)}%`,
        top: `${String(box.y * 100)}%`,
        width: `${String(box.width * 100)}%`,
        height: `${String(box.height * 100)}%`,
      }}
    >
      <span className="absolute -top-4 left-0 rounded bg-primary px-1 text-[9px] font-semibold uppercase tracking-wide text-white">
        {t('detectionIntelligence.plateDetailPanel.plate', 'Plate')}
      </span>
    </div>
  )
}

export function PlateDetailPanel({
  plate,
  cameraName,
  onClose,
  onAssign,
  onUnassign,
  onDelete,
  actionsPending,
}: PlateDetailPanelProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: media, isFetching } = usePlateGalleryGetPlateMedia(
    { plateId: plate?.plateId ?? '' },
    { enabled: plate !== null },
  )
  const correctText = usePlateGalleryCorrectPlateText()
  const [mode, setMode] = useState<ImageMode>('frame')
  const [editingText, setEditingText] = useState(false)
  const [draftText, setDraftText] = useState('')

  const {
    frameSrc,
    naturalWidth,
    naturalHeight,
    failed: frameFailed,
  } = useKeyFrameAdapter(plate?.keyFrameMediaId)

  // Reset the inline-edit state whenever a different plate is opened.
  useEffect(() => {
    setEditingText(false)
    setDraftText('')
    setMode('frame')
  }, [plate?.plateId])

  // `getPlateMedia` stays the richest source but no longer inlines: every row
  // carries `url`, the event-media plane path for that crop's key — the same
  // plane this dialog's key FRAME already comes from. The fallback still goes
  // through `plateCropSrc` because the gallery asks `includeCrops: false`, so
  // `plate.base64` is absent on those rows and reading it directly would blank
  // the panel for every plate whose media call is in flight or empty.
  const cropSrc = useMemo(() => {
    const best = pickBestMedia(media ?? [])
    if (best) return best.url
    return plateCropSrc(plate)
  }, [media, plate])

  const normalizedBbox = useMemo(() => {
    if (!plate?.plateBbox || naturalWidth === null || naturalHeight === null) return null
    return normalizeFaceBbox(plate.plateBbox, naturalWidth, naturalHeight)
  }, [plate?.plateBbox, naturalWidth, naturalHeight])

  if (plate === null) return null

  const hasFrame = plate.keyFrameMediaId !== undefined && !frameFailed
  const showFrame = hasFrame && mode === 'frame'

  const vehicleLabel = plate.assigned
    ? (plate.vehicleName ?? 'Assigned')
    : plate.recognizedVehicleId
      ? `${plate.vehicleName ?? 'Recognized'} (suggested)`
      : 'Unassigned'

  const scorePct = `${String(Math.round(plate.score * 100))}%${plate.corrected ? ' · corrected' : ''}`

  function startEditText() {
    if (!plate) return
    setDraftText(plate.text)
    setEditingText(true)
  }
  function saveText() {
    if (!plate) return
    const trimmed = draftText.trim().toUpperCase()
    if (!trimmed || trimmed === plate.text) {
      setEditingText(false)
      return
    }
    correctText.mutate(
      { plateId: plate.plateId, text: trimmed },
      {
        onSettled: () => {
          void queryClient.invalidateQueries({ queryKey: PLATE_GALLERY_KEY })
          setEditingText(false)
        },
      },
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        width="lg"
        placement="sheet-on-mobile"
        aria-label={t('detectionIntelligence.plateDetailPanel.plateDetail', 'Plate detail')}
        className={
          // Mobile: a DEFINITE near-full height so the `flex-1 min-h-0` body
          // scrolls deterministically (see EventDetailPanel for the full
          // rationale — a `max-h`-only sheet compresses on iOS Safari). md+:
          // revert to `h-auto` + `max-h` for the unchanged centered card.
          'flex h-[92dvh] flex-col gap-0 overflow-hidden p-0 ' +
          'bottom-0 left-0 right-0 top-auto w-full max-w-full translate-x-0 translate-y-0 rounded-b-none ' +
          'md:bottom-auto md:left-1/2 md:right-auto md:top-1/2 md:h-auto md:w-[calc(100vw-2rem)] md:max-w-xl ' +
          'md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg md:max-h-[calc(100dvh-2rem)]'
        }
      >
        {/* Header — Close is the DialogContent built-in (pr-10 clears its hit area). */}
        <header className="flex shrink-0 items-start gap-2 border-b border-border py-3 pl-4 pr-10">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm font-semibold tracking-wide text-foreground">
              {plate.text ||
                t('detectionIntelligence.plateDetailPanel.plateDetail', 'Plate detail')}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-foreground-subtle">{cameraName}</div>
          </div>
        </header>

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
          {hasFrame && (
            <div className="flex items-center gap-1 rounded-md border border-border p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setMode('frame')}
                className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 transition-colors ${
                  mode === 'frame'
                    ? 'bg-primary/12 font-medium text-primary'
                    : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
                }`}
              >
                <Scan className="h-3.5 w-3.5" /> {t('detectionIntelligence.detailPanel.fullFrame')}
              </button>
              <button
                type="button"
                onClick={() => setMode('crop')}
                className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 transition-colors ${
                  mode === 'crop'
                    ? 'bg-primary/12 font-medium text-primary'
                    : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
                }`}
              >
                <Crop className="h-3.5 w-3.5" /> {t('detectionIntelligence.detailPanel.crop')}
              </button>
            </div>
          )}

          {showFrame && frameSrc ? (
            <div className="overflow-hidden rounded-lg border border-border bg-background">
              <ZoomableImage
                src={frameSrc}
                alt={t(
                  'detectionIntelligence.plateDetailPanel.fullFrameWithDetectedPlate',
                  'Full frame with detected plate',
                )}
                fit="natural"
                className="w-full"
                overlay={normalizedBbox ? <PlateBoxOverlay box={normalizedBbox} /> : undefined}
              />
            </div>
          ) : cropSrc ? (
            <div className="relative aspect-[2/1] w-full overflow-hidden rounded-lg border border-border bg-background">
              <ZoomableImage
                src={cropSrc}
                alt={t('detectionIntelligence.plateDetailPanel.detectedPlate', 'Detected plate')}
                className="h-full w-full"
              />
              {isFetching && (
                <div className="absolute right-2 top-2 rounded-full bg-black/50 p-1 text-white">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                </div>
              )}
            </div>
          ) : (
            <div className="flex aspect-[2/1] w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-border bg-warning/5 text-foreground-subtle">
              <ImageOff className="h-8 w-8 text-warning/70" />
              <span className="text-[11px] font-medium uppercase tracking-wide text-warning/80">
                {t('detectionIntelligence.plateDetailPanel.noImage', 'No image')}
              </span>
              <span className="px-6 text-center text-[10px] text-foreground-subtle">
                {t(
                  'detectionIntelligence.plateDetailPanel.theCropMediaForThis',
                  'The crop media for this plate could not be resolved. Safe to delete.',
                )}
              </span>
            </div>
          )}

          {/* OCR text — editable (self-labeling identity) */}
          <div className="rounded-lg border border-border bg-surface px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-[11px] uppercase tracking-wide text-foreground-subtle">
                {t('detectionIntelligence.plateDetailPanel.plateText', 'Plate text')}
              </span>
              {editingText ? (
                <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
                  <Input
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveText()
                      if (e.key === 'Escape') setEditingText(false)
                    }}
                    className="h-7 max-w-[10rem] text-right font-mono text-xs uppercase"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={saveText}
                    disabled={correctText.isPending}
                    className="text-success hover:text-success/80 disabled:opacity-50"
                    aria-label={t(
                      'detectionIntelligence.plateDetailPanel.saveCorrectedText',
                      'Save corrected text',
                    )}
                  >
                    {correctText.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingText(false)}
                    className="text-foreground-subtle hover:text-foreground"
                    aria-label={t('common.cancel', 'Cancel')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={startEditText}
                  className="group flex min-w-0 items-center gap-1.5"
                  title={t(
                    'detectionIntelligence.plateDetailPanel.correctTheOcrReading',
                    'Correct the OCR reading',
                  )}
                >
                  <span className="truncate font-mono text-sm font-semibold tracking-wide text-foreground">
                    {plate.text || '—'}
                  </span>
                  <Pencil className="h-3 w-3 shrink-0 text-foreground-subtle group-hover:text-foreground" />
                </button>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface px-3 py-1">
            <MetaRow
              label={t('detectionIntelligence.plateDetailPanel.camera', 'Camera')}
              value={cameraName}
            />
            <MetaRow
              label={t('detectionIntelligence.plateDetailPanel.captured', 'Captured')}
              value={formatFaceTimestampFull(plate.timestamp)}
            />
            <MetaRow
              label={t('detectionIntelligence.plateDetailPanel.confidence', 'Confidence')}
              value={scorePct}
            />
            <MetaRow
              label={t('detectionIntelligence.plateDetailPanel.vehicle', 'Vehicle')}
              value={vehicleLabel}
            />
            <MetaRow
              label={t('detectionIntelligence.plateDetailPanel.track', 'Track')}
              value={plate.trackId}
              mono
            />
          </div>
        </div>

        {/* Footer actions */}
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {plate.assigned ? (
            <Button
              variant="secondary"
              onClick={() => onUnassign(plate.plateId)}
              disabled={actionsPending}
            >
              <UserX className="h-3.5 w-3.5" /> {t('detectionIntelligence.detailPanel.detach')}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => onAssign(plate.plateId)}
              disabled={actionsPending}
            >
              <UserCheck className="h-3.5 w-3.5" /> {t('common.assign')}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => onDelete(plate.plateId)}
            disabled={actionsPending}
          >
            <Trash2 className="h-3.5 w-3.5" /> {t('common.delete')}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
