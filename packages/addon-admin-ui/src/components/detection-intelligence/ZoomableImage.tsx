/**
 * ZoomableImage — a self-contained click-to-zoom image for the face detail
 * modal. No such primitive exists in ui-library (HoverZoomImage is a
 * hover-preview thumbnail, not an interactive zoom), so this fills the gap.
 *
 * - Click / tap toggles a 1x ⇄ 2.6x scale.
 * - Zoom origin follows the pointer so you can inspect a specific area.
 * - CSS-only transform; works on touch (tap) and desktop (click).
 * - `overlay` is rendered in the SAME transformed space as the image, so a
 *   bounding box painted in normalized coords stays glued to the pixels it
 *   marks through the zoom (used for the forward-looking full-frame + face-box
 *   view).
 * - `fit`: `'contain'` frames the image inside a fixed-size box (the crop
 *   use-case). `'natural'` lets the container height follow the image aspect so
 *   a normalized overlay lines up exactly with no letterbox gap (the full-frame
 *   use-case).
 */
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'

interface ZoomableImageProps {
  readonly src: string
  readonly alt: string
  /** Extra classes for the framing container (aspect / rounding). */
  readonly className?: string
  /** Painted in the transformed space, above the image (e.g. a bbox rect). */
  readonly overlay?: ReactNode
  /** Layout mode — see file header. Default `'contain'`. */
  readonly fit?: 'contain' | 'natural'
}

const ZOOM_SCALE = 2.6

export function ZoomableImage({
  src,
  alt,
  className,
  overlay,
  fit = 'contain',
}: ZoomableImageProps) {
  const [zoomed, setZoomed] = useState(false)
  const [origin, setOrigin] = useState('50% 50%')

  // A new frame (e.g. an event-detail filmstrip swap) must start un-zoomed:
  // otherwise the stale zoom scale + pointer origin carry over, leaving the
  // freshly selected image stuck magnified in a corner and any subsequent
  // click just zooming out instead of inspecting the new frame.
  useEffect(() => {
    setZoomed(false)
    setOrigin('50% 50%')
  }, [src])

  function handleClick(e: MouseEvent<HTMLDivElement>) {
    if (!zoomed) {
      const rect = e.currentTarget.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * 100
      const y = ((e.clientY - rect.top) / rect.height) * 100
      setOrigin(`${String(x)}% ${String(y)}%`)
    }
    setZoomed((z) => !z)
  }

  const natural = fit === 'natural'

  return (
    <div
      className={`relative overflow-hidden bg-background ${className ?? ''}`}
      onClick={handleClick}
    >
      {/* Transformed layer holds image + overlay so both scale together. */}
      <div
        className={`relative select-none transition-transform duration-200 ease-out ${
          natural ? 'w-full' : 'h-full w-full'
        } ${zoomed ? 'cursor-zoom-out' : 'cursor-zoom-in'}`}
        style={{
          transformOrigin: origin,
          transform: zoomed ? `scale(${String(ZOOM_SCALE)})` : 'scale(1)',
        }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className={
            natural ? 'block h-auto w-full object-contain' : 'h-full w-full object-contain'
          }
        />
        {overlay}
      </div>
    </div>
  )
}
