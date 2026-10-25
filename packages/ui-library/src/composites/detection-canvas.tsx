/**
 * DetectionCanvas — renders an image with overlaid bounding boxes.
 *
 * Adapted to the Phase 6 detection output rework: consumes the new
 * `ObjectDetection` shape (flat at root, `bbox: {x,y,width,height}`,
 * `labels: ScoredLabel[]`, `parentId` for details). Details (face,
 * plate) are drawn as inner boxes correlated with their parent via
 * `parentId`.
 */
import { useUiText } from '../contexts/ui-text'
import { type JSX, type ReactNode, useRef, useEffect } from 'react'
import { cn } from '../lib/cn'
import { useClassPainter } from './display-palette-context'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ObjectDetection, ScoredLabel, DetectionBoundingBox } from '@camstack/types'
import type { ObjectDetection, ScoredLabel, DetectionBoundingBox } from '@camstack/types'

/** Legacy alias kept so pre-rework consumers don't need a coordinated rename. */
export type Detection = ObjectDetection

export interface DetectionCanvasProps {
  /** Image source (data URL or regular URL) */
  readonly src: string | null
  /** Image dimensions (used for bbox coordinate mapping) */
  readonly imageWidth: number
  readonly imageHeight: number
  /** Detections to overlay — flat list (first-level + details). */
  readonly detections?: readonly ObjectDetection[]
  /** Custom class → hex color mapping (merged with defaults) */
  readonly classColors?: Readonly<Record<string, string>>
  /** Aspect ratio CSS value (default: auto based on image dimensions) */
  readonly aspectRatio?: string
  /** Additional CSS classes on the container */
  readonly className?: string
  /** Placeholder content when no image is loaded */
  readonly placeholder?: ReactNode
  /** Show confidence percentage in bbox labels */
  readonly showConfidence?: boolean
  /** Minimum confidence to display (0-1, default: 0) */
  readonly minConfidence?: number
  /** Border width for bboxes in px (default: 2) */
  readonly borderWidth?: number
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DetectionCanvas({
  src,
  imageWidth,
  imageHeight,
  detections = [],
  classColors,
  aspectRatio,
  className,
  placeholder,
  showConfidence = true,
  minConfidence = 0,
  borderWidth = 2,
}: DetectionCanvasProps): JSX.Element {
  const t = useUiText()
  const paint = useClassPainter()
  function getColor(cls: string): string {
    return paint(cls, classColors)
  }

  const ratio = aspectRatio ?? (imageWidth && imageHeight ? `${imageWidth}/${imageHeight}` : '16/9')

  const filtered = detections.filter((d) => d.score >= minConfidence)
  const firstLevel = filtered.filter((d) => d.kind === 'first-level')
  const details = filtered.filter((d) => d.kind === 'detail')
  const detailsByParent = groupBy(details, (d) => d.parentId ?? '')

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-surface overflow-hidden relative',
        className,
      )}
      style={{ aspectRatio: ratio }}
    >
      {src ? (
        <>
          {/* Image — absolute so it shares coordinate space with bbox overlays */}
          <img src={src} className="absolute inset-0 w-full h-full object-fill" alt="" />

          {/* Segmentation mask overlays (rendered behind bounding boxes) */}
          {filtered.map((d, i) =>
            d.debug?.mask && d.debug.maskWidth && d.debug.maskHeight ? (
              <MaskOverlay
                key={`mask-${i}`}
                mask={d.debug.mask}
                maskWidth={d.debug.maskWidth}
                maskHeight={d.debug.maskHeight}
                bbox={d.bbox}
                imageWidth={imageWidth}
                imageHeight={imageHeight}
                color={getColor(d.macroClass)}
              />
            ) : null,
          )}

          {/* First-level detection boxes (person / vehicle / animal) */}
          {firstLevel.map((d) => {
            const children = detailsByParent.get(d.id) ?? []
            return (
              <BoundingBox
                key={`det-${d.id}`}
                detection={d}
                imageWidth={imageWidth}
                imageHeight={imageHeight}
                color={getColor(d.macroClass)}
                showConfidence={showConfidence}
                borderWidth={d.debug?.mask ? 1 : borderWidth}
              >
                {children.map((child) => (
                  <ChildBoundingBox
                    key={`child-${child.id}`}
                    child={child}
                    parentBbox={d.bbox}
                    color={getColor(child.macroClass)}
                    showConfidence={showConfidence}
                  />
                ))}
              </BoundingBox>
            )
          })}

          {/* Orphan details (no parentId or parent not in view) */}
          {details
            .filter((d) => !d.parentId || !firstLevel.some((p) => p.id === d.parentId))
            .map((d) => (
              <BoundingBox
                key={`orphan-${d.id}`}
                detection={d}
                imageWidth={imageWidth}
                imageHeight={imageHeight}
                color={getColor(d.macroClass)}
                showConfidence={showConfidence}
                borderWidth={borderWidth}
              />
            ))}
        </>
      ) : (
        <div className="w-full h-full flex items-center justify-center text-foreground-subtle text-sm">
          {placeholder ?? t('uiLibrary.detectionCanvas.noImage', 'No image loaded')}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function BoundingBox({
  detection,
  imageWidth,
  imageHeight,
  color,
  showConfidence,
  borderWidth,
  children,
}: {
  detection: ObjectDetection
  imageWidth: number
  imageHeight: number
  color: string
  showConfidence: boolean
  borderWidth: number
  children?: ReactNode
}) {
  const paint = useClassPainter()
  const { x, y, width, height } = detection.bbox

  const labelsElement = (
    <div
      className="absolute left-0 flex flex-col items-start gap-px"
      style={{ bottom: '100%', marginBottom: '2px' }}
    >
      <span
        className="text-[10px] px-1 rounded-sm whitespace-nowrap text-white"
        style={{ backgroundColor: color }}
      >
        {detection.macroClass}
        {showConfidence && ` ${(detection.score * 100).toFixed(0)}%`}
      </span>
      {detection.labels.map((l: ScoredLabel, k: number) => (
        <span
          key={`${detection.id}-lbl-${k}`}
          className="text-[9px] font-semibold px-1 rounded-sm whitespace-nowrap text-white"
          style={{ backgroundColor: paint(l.label) }}
        >
          {l.label} {(l.score * 100).toFixed(0)}%
        </span>
      ))}
    </div>
  )

  return (
    <div
      className="absolute rounded-sm"
      style={{
        left: `${(x / imageWidth) * 100}%`,
        top: `${(y / imageHeight) * 100}%`,
        width: `${(width / imageWidth) * 100}%`,
        height: `${(height / imageHeight) * 100}%`,
        borderWidth: `${borderWidth}px`,
        borderStyle: 'solid',
        borderColor: color,
      }}
    >
      {labelsElement}
      {children}
    </div>
  )
}

/** Renders a segmentation mask as a semi-transparent colored canvas overlay */
function MaskOverlay({
  mask,
  maskWidth,
  maskHeight,
  bbox,
  imageWidth,
  imageHeight,
  color,
}: {
  mask: string
  maskWidth: number
  maskHeight: number
  bbox: DetectionBoundingBox
  imageWidth: number
  imageHeight: number
  color: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const binary = atob(mask)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

    const r = parseInt(color.slice(1, 3), 16)
    const g = parseInt(color.slice(3, 5), 16)
    const b = parseInt(color.slice(5, 7), 16)

    canvas.width = maskWidth
    canvas.height = maskHeight
    const imageData = ctx.createImageData(maskWidth, maskHeight)
    const totalPixels = maskWidth * maskHeight

    for (let i = 0; i < totalPixels; i++) {
      const val = i < bytes.length ? bytes[i]! : 0
      const px = i * 4
      if (val > 0) {
        imageData.data[px] = r
        imageData.data[px + 1] = g
        imageData.data[px + 2] = b
        imageData.data[px + 3] = 120 // semi-transparent
      }
    }

    ctx.putImageData(imageData, 0, 0)
  }, [mask, maskWidth, maskHeight, color])

  return (
    <canvas
      ref={canvasRef}
      className="absolute pointer-events-none"
      style={{
        left: `${(bbox.x / imageWidth) * 100}%`,
        top: `${(bbox.y / imageHeight) * 100}%`,
        width: `${(bbox.width / imageWidth) * 100}%`,
        height: `${(bbox.height / imageHeight) * 100}%`,
        imageRendering: 'pixelated',
      }}
    />
  )
}

function ChildBoundingBox({
  child,
  parentBbox,
  color,
  showConfidence,
}: {
  child: ObjectDetection
  parentBbox: DetectionBoundingBox
  color: string
  showConfidence: boolean
}) {
  const paint = useClassPainter()
  if (parentBbox.width <= 0 || parentBbox.height <= 0) return null

  const relLeft = ((child.bbox.x - parentBbox.x) / parentBbox.width) * 100
  const relTop = ((child.bbox.y - parentBbox.y) / parentBbox.height) * 100
  const relWidth = (child.bbox.width / parentBbox.width) * 100
  const relHeight = (child.bbox.height / parentBbox.height) * 100

  return (
    <div
      className="absolute rounded-sm"
      style={{
        left: `${Math.max(0, relLeft)}%`,
        top: `${Math.max(0, relTop)}%`,
        width: `${Math.min(100, relWidth)}%`,
        height: `${Math.min(100, relHeight)}%`,
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: color,
      }}
    >
      <div
        className="absolute left-0 flex flex-col items-start gap-px"
        style={{ bottom: '100%', marginBottom: '1px' }}
      >
        <span
          className="text-[9px] px-0.5 rounded-sm whitespace-nowrap text-white"
          style={{ backgroundColor: color }}
        >
          {child.macroClass}
          {showConfidence && ` ${(child.score * 100).toFixed(0)}%`}
        </span>
        {child.labels.map((l: ScoredLabel, k: number) => (
          <span
            key={`${child.id}-lbl-${k}`}
            className="text-[8px] font-semibold px-0.5 rounded-sm whitespace-nowrap text-white"
            style={{ backgroundColor: paint(l.label) }}
          >
            {l.label} {(l.score * 100).toFixed(0)}%
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupBy<T, K>(items: readonly T[], keyFn: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const item of items) {
    const key = keyFn(item)
    const arr = out.get(key) ?? []
    arr.push(item)
    out.set(key, arr)
  }
  return out
}
