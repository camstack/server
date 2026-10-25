/**
 * Image controls for a `DeviceType.Image` device.
 *
 * Read-only: the `image` cap has no setters. Reads the `image` cap status
 * slice (an absolute signed `url` the browser loads directly) and renders:
 *   - ImageInlineControl (device-list row): a small thumbnail when a url
 *     is present; a muted `ImageOff` placeholder when null. Row-narrow.
 *   - ImageHeroCard (device-detail hero): a framed image in the
 *     cover-style framed box (object-contain) when a url is present; a
 *     centered placeholder when null.
 *
 * Mirrors the read pattern of the other controls' `useDeviceCapability`
 * usage so the row and hero never diverge.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ImageOff, ZoomIn, ZoomOut, RotateCcw, X } from 'lucide-react'
import type { ImageStatus } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useUiText } from '../../contexts/ui-text'
import { Dialog, DialogContent } from '../../primitives/dialog'
import type { DeviceControlProps } from './control-registry'

function useImage(trpc: DeviceControlProps['trpc'], deviceId: number) {
  return useDeviceCapability<unknown, ImageStatus>({
    trpc,
    deviceId,
    cap: (d) => d.image,
    slice: (d) => d.state.image,
  })
}

// ── Detail modal (zoom + pan + padding) ─────────────────────────────────────

const ZOOM_MIN = 1
const ZOOM_MAX = 6
const ZOOM_STEP = 0.5

/**
 * ImageDetailModal — a full-view image dialog with zoom in/out/reset and pan
 * (scroll when zoomed). Generous padding frames the image. Opened by clicking
 * the inline thumbnail or the hero image. Controlled via `open`/`onOpenChange`.
 */
export function ImageDetailModal({
  url,
  alt,
  open,
  onOpenChange,
}: {
  readonly url: string
  readonly alt: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}): ReactNode {
  const t = useUiText()
  const [scale, setScale] = useState(1)
  // Reset zoom whenever the modal opens or the image changes.
  useEffect(() => {
    if (open) setScale(1)
  }, [open, url])

  const zoomIn = useCallback(() => setScale((s) => Math.min(ZOOM_MAX, s + ZOOM_STEP)), [])
  const zoomOut = useCallback(() => setScale((s) => Math.max(ZOOM_MIN, s - ZOOM_STEP)), [])
  const reset = useCallback(() => setScale(1), [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width="lg" className="max-w-5xl p-6">
        <div className="flex items-center justify-between gap-2 mb-3">
          <span className="truncate text-sm font-semibold text-foreground">{alt}</span>
          <div className="flex items-center gap-1">
            <ModalIconButton
              label={t('uiLibrary.imageControl.zoomOut', 'Zoom out')}
              disabled={scale <= ZOOM_MIN}
              onClick={zoomOut}
            >
              <ZoomOut className="h-4 w-4" />
            </ModalIconButton>
            <span className="tabular-nums text-xs text-foreground-subtle w-10 text-center">
              {Math.round(scale * 100)}%
            </span>
            <ModalIconButton
              label={t('uiLibrary.imageControl.zoomIn', 'Zoom in')}
              disabled={scale >= ZOOM_MAX}
              onClick={zoomIn}
            >
              <ZoomIn className="h-4 w-4" />
            </ModalIconButton>
            <ModalIconButton
              label={t('uiLibrary.imageControl.resetZoom', 'Reset zoom')}
              disabled={scale === 1}
              onClick={reset}
            >
              <RotateCcw className="h-4 w-4" />
            </ModalIconButton>
            <ModalIconButton
              label={t('uiLibrary.imageControl.close', 'Close')}
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4" />
            </ModalIconButton>
          </div>
        </div>
        {/* Padded, scrollable stage. Zoom grows the image's REAL width so the
            overflow-auto scroll area grows with it — this is what lets you pan
            (scroll) all the way to every edge, padding included. A CSS transform
            would only scale visually and leave the scroll area unchanged, so the
            edges stayed unreachable when zoomed. */}
        <div className="max-h-[78vh] overflow-auto rounded border border-border bg-gradient-to-b from-surface-hover to-surface p-6">
          <img
            src={url}
            alt={alt}
            style={{ width: `${scale * 100}%`, maxWidth: 'none' }}
            className="mx-auto block h-auto transition-[width] duration-150"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ModalIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  )
}

// ── Inline ──────────────────────────────────────────────────────────────────

/**
 * ImageInlineControl — compact thumbnail for a device-list row that expands
 * into a floating preview on hover/focus (shared `HoverZoomImage`). Shows a
 * muted ImageOff placeholder box when no url is available. Row-narrow.
 *
 * `DeviceControlProps` carries no device name, so the alt/caption is the
 * generic 'Image'; the framed hero (ImageHeroCard) carries the real name.
 */
export function ImageInlineControl({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { slice } = useImage(trpc, deviceId)
  const [open, setOpen] = useState(false)
  if (slice === undefined) return null

  const url = slice.url
  if (url === null) {
    return (
      <span
        className="inline-flex h-7 w-7 items-center justify-center rounded bg-surface-hover text-foreground-subtle"
        title={t('uiLibrary.imageControl.noImage', 'No image')}
      >
        <ImageOff className="h-4 w-4" aria-hidden="true" />
      </span>
    )
  }

  return (
    <>
      <button
        type="button"
        title={t('uiLibrary.imageControl.viewImage', 'View image')}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        className="inline-flex items-center justify-center rounded ring-offset-1 hover:ring-2 hover:ring-primary/50 transition"
      >
        <img
          src={url}
          alt={t('uiLibrary.imageControl.image', 'Image')}
          className="h-7 w-7 rounded object-cover"
        />
      </button>
      <ImageDetailModal
        url={url}
        alt={t('uiLibrary.imageControl.image', 'Image')}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  )
}

// ── Hero ────────────────────────────────────────────────────────────────────

export interface ImageHeroCardProps extends DeviceControlProps {
  /** Optional device name for the image alt text. */
  readonly deviceName?: string
}

/**
 * ImageHeroCard — read-only framed image for the device-detail hero.
 *
 * A still image in the cover-style framed box (rounded border,
 * object-contain) when a url is present; a centered ImageOff + "No image"
 * placeholder when null. Keeps the framed-box chrome for visual
 * consistency with the other heroes.
 */
export function ImageHeroCard({ trpc, deviceId, deviceName }: ImageHeroCardProps): ReactNode {
  const t = useUiText()
  const { slice } = useImage(trpc, deviceId)
  // Fall back to the placeholder if the image fails to load (e.g. expired
  // token). Reset the flag whenever the url changes.
  const [errored, setErrored] = useState(false)
  const [open, setOpen] = useState(false)
  const url = slice?.url ?? null
  useEffect(() => {
    setErrored(false)
  }, [url])
  if (slice === undefined) return null

  return (
    <div className="flex flex-col items-stretch gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex w-full items-center justify-center overflow-hidden rounded border-2 border-border bg-gradient-to-b from-surface-hover to-surface">
        {slice.url !== null && !errored ? (
          <button
            type="button"
            title={t('uiLibrary.imageControl.viewImage', 'View image')}
            onClick={() => setOpen(true)}
            className="flex w-full cursor-zoom-in items-center justify-center"
          >
            <img
              src={slice.url}
              alt={deviceName ?? t('uiLibrary.imageControl.image', 'Image')}
              onError={() => setErrored(true)}
              className="max-h-72 w-full object-contain"
            />
          </button>
        ) : (
          <div
            data-testid="image-placeholder"
            className="flex h-48 w-full flex-col items-center justify-center gap-2 text-foreground-subtle"
          >
            <ImageOff className="h-8 w-8" aria-hidden="true" />
            <span className="text-xs">{t('uiLibrary.imageControl.noImage', 'No image')}</span>
          </div>
        )}
      </div>
      {url !== null && !errored && (
        <ImageDetailModal
          url={url}
          alt={deviceName ?? t('uiLibrary.imageControl.image', 'Image')}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </div>
  )
}
