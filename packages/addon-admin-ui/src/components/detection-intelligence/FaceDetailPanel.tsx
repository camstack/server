/**
 * FaceDetailPanel — enlarged, zoomable view of a single detected face plus its
 * full metadata (camera, timestamp, track, assignment/identity).
 *
 * ## Why a top-layer Dialog and not SlideOverPanel
 * `SlideOverPanel` is (by design) anchored to its nearest positioned ancestor on
 * desktop (`md:absolute`). On the Detection-Intelligence page that ancestor is
 * the gallery's own `relative` wrapper, so the slide-over was clipped / never
 * fully visible. This modal instead renders through the `Dialog` primitive,
 * whose `<dialog showModal()>` is promoted to the browser TOP LAYER — it is
 * viewport-anchored and cannot be clipped by any ancestor's overflow/transform,
 * regardless of the page's inner layout. Centered card on desktop, full-width
 * sheet on mobile (`placement="sheet-on-mobile"` — the hand-rolled override
 * classes below stay in place too: the deployed ui-library may predate the
 * `placement` prop during the framework-train gap, so the classes are a
 * co-existing fallback until a follow-up commit removes them).
 *
 * ## Image source (keyFrame adapter)
 * When the face carries a `keyFrameMediaId` we fetch the native key frame off
 * the admin-gated event-media data-plane (`mediaIdPath` →
 * `/addon/pipeline-analytics/event-media/m/<id>`, same Bearer-token-via-
 * fetch+blob pattern as `ArchiveList`'s download — `<img>` cannot carry the
 * Authorization header, so we build an object URL), read its natural
 * dimensions from the loaded image, and normalize the pixel `faceBbox`
 * (`normalizeFaceBbox`, see `face-bbox.ts`) into the overlay `ZoomableImage`
 * expects. Frame ⇄ Crop toggle drives it; crop stays the fallback whenever
 * the id/media is absent, still loading, or errored.
 */

import { Button, Dialog, DialogContent, useFaceGalleryGetFaceMedia } from '@camstack/ui-library'
import { Crop, ImageOff, Loader2, Scan, Trash2, UserCheck, UserX } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { authedFetchBlob, mediaIdPath } from '../../lib/authed-media.js'
import { formatFaceTimestampFull } from '../../lib/face-gallery-filters.js'
import { faceCropSrc } from '../../lib/face-gallery-selection.js'
import { normalizeFaceBbox } from './face-bbox.js'
import type { FaceInfo, NormalizedBox } from './types.js'
import { ZoomableImage } from './ZoomableImage.js'
import { useTranslation } from 'react-i18next'

interface KeyFrameAdapterResult {
  /** Object URL for the fetched native key frame, or `null` until ready. */
  readonly frameSrc: string | null
  readonly naturalWidth: number | null
  readonly naturalHeight: number | null
  /** True once the fetch (or the subsequent image decode) has failed. */
  readonly failed: boolean
}

/**
 * Fetches the native key frame for `mediaId` (admin bearer auth via fetch,
 * since `<img>` can't carry the header — mirrors `ArchiveList`'s download
 * pattern), exposes it as an object URL, and reads its natural pixel
 * dimensions once decoded. Re-runs whenever `mediaId` changes; always
 * revokes the previous object URL on cleanup.
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

/**
 * `key` is still a MediaStore key here, NOT a D482 row id: `face-gallery
 * .cap.ts`'s `MediaFileLiteSchema` (what `getFaceMedia` returns) has not made
 * that move (unlike `pipeline-analytics.cap.ts`'s track/event media). The
 * row's own `url` is server-minted regardless, so `pickBestMedia` below reads
 * that and never the key.
 */
interface MediaFileLite {
  /** The media row's own id (D482) — the address, never a composite key. */
  readonly mediaId: number
  readonly kind: string
  /** Event-media plane path for this crop. No bytes travel with the row. */
  readonly url: string
  readonly sizeBytes: number
  readonly timestamp: number
}

interface FaceDetailPanelProps {
  readonly face: FaceInfo | null
  readonly cameraName: string
  readonly onClose: () => void
  readonly onAssign: (faceId: string) => void
  readonly onUnassign: (faceId: string) => void
  readonly onDelete: (faceId: string) => void
  readonly actionsPending: boolean
}

type ImageMode = 'frame' | 'crop'

/**
 * Pick the crop-like media entry, else the first that is addressable.
 *
 * The gate is a non-empty URL, not non-empty bytes. It used to read
 * `m.base64.length > 0`; leaving that in place while the rows stopped
 * inlining would have returned null for every row and blanked the crop —
 * the same one-line failure `EventDetailPanel` documents for its filmstrip.
 */
function pickBestMedia(media: readonly MediaFileLite[]): MediaFileLite | null {
  const addressable = media.filter((m) => m.url.length > 0)
  if (addressable.length === 0) return null
  return addressable.find((m) => /crop|face/i.test(m.kind)) ?? addressable[0]
}

function MetaRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-border/60 last:border-0">
      <span className="shrink-0 text-[11px] uppercase tracking-wide text-foreground-subtle">
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-xs font-medium text-foreground">
        {value}
      </span>
    </div>
  )
}

/** The face rectangle painted over the full frame, in normalized coords. */
function FaceBoxOverlay({ box }: { readonly box: NormalizedBox }) {
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
        {t('detectionIntelligence.faceDetailPanel.face', 'Face')}
      </span>
    </div>
  )
}

export function FaceDetailPanel({
  face,
  cameraName,
  onClose,
  onAssign,
  onUnassign,
  onDelete,
  actionsPending,
}: FaceDetailPanelProps) {
  const { t } = useTranslation()
  const { data: media, isFetching } = useFaceGalleryGetFaceMedia(
    { faceId: face?.faceId ?? '' },
    { enabled: face !== null },
  )
  const [mode, setMode] = useState<ImageMode>('frame')
  const {
    frameSrc,
    naturalWidth,
    naturalHeight,
    failed: frameFailed,
  } = useKeyFrameAdapter(face?.keyFrameMediaId)

  // `getFaceMedia` is the primary source. It no longer inlines: every row
  // carries `url`, the event-media plane path for that crop's key — the same
  // plane `useKeyFrameAdapter` above already renders this dialog's key FRAME
  // from. The row's own `cropUrl` stays the fallback while the media call is in
  // flight or returns nothing, because the gallery asks `includeCrops: false`.
  //
  // Both are same-origin relative paths on an `authenticated` plane, so the
  // browser's session cookie authenticates the `<img>`; no Bearer is possible
  // on an image element and none is needed here.
  const cropSrc = useMemo(() => {
    const best = pickBestMedia(media ?? [])
    if (best) return best.url
    return faceCropSrc(face)
  }, [media, face])

  const normalizedBbox = useMemo(() => {
    if (!face?.faceBbox || naturalWidth === null || naturalHeight === null) return null
    return normalizeFaceBbox(face.faceBbox, naturalWidth, naturalHeight)
  }, [face?.faceBbox, naturalWidth, naturalHeight])

  if (face === null) return null

  // Toggle is offered whenever a key frame is expected and hasn't errored —
  // crop is the fallback while the fetch/decode is still in flight (frameSrc
  // is null) and stays the fallback permanently on error.
  const hasFrame = face.keyFrameMediaId !== undefined && !frameFailed
  // Frame is the default when available; the toggle only appears when both exist.
  const showFrame = hasFrame && mode === 'frame'

  const identityLabel = face.assigned
    ? (face.identityName ?? 'Assigned')
    : face.recognizedIdentityId
      ? `${face.identityName ?? 'Recognized'} (suggested)`
      : 'Unassigned'

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        width="lg"
        placement="sheet-on-mobile"
        aria-label={t('detectionIntelligence.faceDetailPanel.faceDetail', 'Face detail')}
        className={
          // Base = mobile bottom sheet pinned to the viewport bottom, tall and
          // full-width. `md:` restores the centered card. p-0 + flex column so
          // the header/footer stay fixed while the body scrolls.
          'flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 ' +
          'bottom-0 left-0 right-0 top-auto w-full max-w-full translate-x-0 translate-y-0 rounded-b-none ' +
          'md:bottom-auto md:left-1/2 md:right-auto md:top-1/2 md:w-[calc(100vw-2rem)] md:max-w-xl ' +
          'md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg md:max-h-[calc(100dvh-2rem)]'
        }
      >
        {/* Header — Close is the DialogContent built-in (pr-10 clears its hit area). */}
        <header className="flex shrink-0 items-start gap-2 border-b border-border py-3 pl-4 pr-10">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">
              {t('detectionIntelligence.faceDetailPanel.faceDetail', 'Face detail')}
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
                  'detectionIntelligence.faceDetailPanel.fullFrameWithDetectedFace',
                  'Full frame with detected face',
                )}
                fit="natural"
                className="w-full"
                overlay={normalizedBbox ? <FaceBoxOverlay box={normalizedBbox} /> : undefined}
              />
            </div>
          ) : cropSrc ? (
            <div className="relative aspect-square w-full overflow-hidden rounded-lg border border-border">
              <ZoomableImage
                src={cropSrc}
                alt={t('detectionIntelligence.faceDetailPanel.detectedFace', 'Detected face')}
                className="h-full w-full"
              />
              {isFetching && (
                <div className="absolute right-2 top-2 rounded-full bg-black/50 p-1 text-white">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                </div>
              )}
            </div>
          ) : (
            <div className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-border bg-warning/5 text-foreground-subtle">
              <ImageOff className="h-8 w-8 text-warning/70" />
              <span className="text-[11px] font-medium uppercase tracking-wide text-warning/80">
                {t('detectionIntelligence.faceDetailPanel.noImage', 'No image')}
              </span>
              <span className="px-6 text-center text-[10px] text-foreground-subtle">
                {t(
                  'detectionIntelligence.faceDetailPanel.theCropMediaForThis',
                  'The crop media for this face could not be resolved (a pre-fix orphan). Safe to delete.',
                )}
              </span>
            </div>
          )}

          <div className="rounded-lg border border-border bg-surface px-3 py-1">
            <MetaRow
              label={t('detectionIntelligence.faceDetailPanel.camera', 'Camera')}
              value={cameraName}
            />
            <MetaRow
              label={t('detectionIntelligence.faceDetailPanel.captured', 'Captured')}
              value={formatFaceTimestampFull(face.timestamp)}
            />
            <MetaRow
              label={t('detectionIntelligence.faceDetailPanel.track', 'Track')}
              value={face.trackId}
            />
            <MetaRow
              label={t('detectionIntelligence.faceDetailPanel.identity', 'Identity')}
              value={identityLabel}
            />
          </div>
        </div>

        {/* Footer actions */}
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {face.assigned ? (
            <Button
              variant="secondary"
              onClick={() => onUnassign(face.faceId)}
              disabled={actionsPending}
            >
              <UserX className="h-3.5 w-3.5" /> {t('detectionIntelligence.detailPanel.detach')}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => onAssign(face.faceId)}
              disabled={actionsPending}
            >
              <UserCheck className="h-3.5 w-3.5" /> {t('common.assign')}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => onDelete(face.faceId)}
            disabled={actionsPending}
          >
            <Trash2 className="h-3.5 w-3.5" /> {t('common.delete')}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
