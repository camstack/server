/**
 * <HoverZoomImage> — a small thumbnail that expands into a floating
 * enlarged preview on hover/focus.
 *
 * One responsibility: render a compact thumbnail (image when `src` is
 * present, a muted `ImageOff` placeholder box when null) and, while the
 * thumbnail is hovered or focused, portal a larger preview to
 * `document.body` positioned with FLIP-ON-COLLISION:
 *   - the position is computed from the thumbnail's `getBoundingClientRect`;
 *   - placed ABOVE the thumbnail unless there is insufficient space (then
 *     below); left-clamped to the viewport;
 *   - `position:fixed`, `pointer-events:none`, `z-[9999]`.
 *
 * The portal is what lets this work inside the device grid, whose overflow
 * ancestors would otherwise clip a normally-positioned popover.
 *
 * Reused by BOTH the Image DeviceType inline control (signed image url) and
 * the camera-snapshot cell in device rows (snapshot blob/object url).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ImageOff } from 'lucide-react'

export interface HoverZoomImageProps {
  /** Image URL (signed url for Image entities; snapshot object url for cameras). Null → placeholder. */
  readonly src: string | null
  /** Accessible alt / default preview caption (e.g. the device name). */
  readonly alt: string
  /** Optional small label under the enlarged preview. Defaults to `alt`. */
  readonly caption?: string
  /** Text shown in the enlarged preview (and implied by the thumbnail's empty state) when there is no image. */
  readonly placeholder?: string
  /** Sizing override for the thumbnail box. Defaults to a compact `h-7 w-7 rounded`. */
  readonly thumbClassName?: string
  /** Enlarged-preview width in px. */
  readonly expandedWidth?: number
  /** Enlarged-preview height in px (drives the flip-on-collision math). */
  readonly expandedHeight?: number
}

interface PreviewPosition {
  readonly top: number
  readonly left: number
}

const DEFAULT_EXPANDED_WIDTH = 288
const DEFAULT_EXPANDED_HEIGHT = 196
const DEFAULT_THUMB_CLASS = 'h-7 w-7 rounded'
const TRIGGER_GAP = 8
const VIEWPORT_MARGIN = 8

export function HoverZoomImage({
  src,
  alt,
  caption,
  placeholder = 'No image',
  thumbClassName = DEFAULT_THUMB_CLASS,
  expandedWidth = DEFAULT_EXPANDED_WIDTH,
  expandedHeight = DEFAULT_EXPANDED_HEIGHT,
}: HoverZoomImageProps): ReactNode {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [position, setPosition] = useState<PreviewPosition | null>(null)
  // Broken-image flag — reset whenever `src` changes so a new url re-tries.
  const [errored, setErrored] = useState(false)
  useEffect(() => {
    setErrored(false)
  }, [src])

  const hasImage = src !== null && !errored
  // Non-null image url for the <img> src when an image is present.
  const safeSrc = src ?? undefined

  // Compute the portal position from the thumbnail's rect: place above
  // unless there is not enough room (then below the more spacious side),
  // and clamp the left edge to the viewport.
  const open = useCallback((): void => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const spaceAbove = rect.top
    const spaceBelow = window.innerHeight - rect.bottom
    const placeBelow = spaceAbove < expandedHeight + TRIGGER_GAP && spaceBelow > spaceAbove
    const top = placeBelow ? rect.bottom + TRIGGER_GAP : rect.top - expandedHeight - TRIGGER_GAP
    const desiredLeft = rect.right - expandedWidth
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(desiredLeft, window.innerWidth - expandedWidth - VIEWPORT_MARGIN),
    )
    setPosition({ top, left })
  }, [expandedWidth, expandedHeight])
  const close = useCallback((): void => setPosition(null), [])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        // Don't let a thumbnail click bubble up into the row's row-click.
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        aria-label={alt}
        className={`flex flex-shrink-0 items-center justify-center overflow-hidden border border-border bg-background text-foreground-subtle transition-colors hover:bg-surface-hover ${thumbClassName}`}
      >
        {hasImage ? (
          <img
            src={safeSrc}
            alt=""
            onError={() => setErrored(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <ImageOff className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
      {position &&
        createPortal(
          <div
            aria-hidden="true"
            style={{
              position: 'fixed',
              top: position.top,
              left: position.left,
              width: expandedWidth,
              pointerEvents: 'none',
            }}
            className="z-[9999] overflow-hidden rounded-lg border border-border bg-surface shadow-lg shadow-black/30"
          >
            <div className="flex h-40 items-center justify-center bg-background">
              {hasImage ? (
                <img src={safeSrc} alt={alt} className="h-full w-full object-cover" />
              ) : (
                <span className="text-xs text-foreground-subtle">{placeholder}</span>
              )}
            </div>
            <div className="px-3 py-2">
              <p className="truncate text-xs font-semibold text-foreground">{caption ?? alt}</p>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
