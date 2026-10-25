/**
 * The annotation canvas — the frame, with every subject on it.
 *
 * What a pointer does depends on where it lands:
 *
 * - on a HANDLE of the selected box → resize that edge or corner;
 * - on a box's body → select it and move it;
 * - on empty frame → draw a new box (a drag below the minimum size is a click,
 *   and deselects);
 * - with Space held, the middle button, or the pan tool on → pan;
 * - two fingers → pinch-zoom and pan; the wheel zooms about the pointer.
 *
 * Every screen↔frame conversion goes through `lib/retrain-zoom.ts`, which
 * accounts for the letterbox (the image is fitted, not stretched) AND the
 * zoom viewport in one place. A move or resize is reported as a GESTURE —
 * start, live boxes, end — so the page records one undo step per drag.
 *
 * What a box looks like says what the operator DID with it (`lib/retrain-box-look.ts`):
 * the stroke colour is the review diff — added, removed, reclassified,
 * adjusted, unchanged, model error, draft — and the source (pipeline, detector,
 * AI vision, drawn) is a small icon on the label. A hovered box thickens and
 * the others dim; a changed box also shows where its proposal was, faintly; a
 * removed proposal is a dotted ghost where it was.
 *
 * The canvas FILLS its parent (a flex child): the frame is fitted inside it
 * (`displayedImageRect`, object-fit contain) and never scrolls.
 */

import {
  type JSX,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useT } from '../../i18n/index.js'
import { RetrainSourceIcon } from './RetrainSourceIcon.js'
import {
  boxAtPoint,
  displayedImageRect,
  dragToBox,
  handleAtPoint,
  handlePoint,
  isDrawnBox,
  moveBox,
  type NormBox,
  type PixelRect,
  RESIZE_HANDLES,
  type ResizeHandle,
  resizeBox,
} from './lib/retrain-boxes.js'
import { estimateLabelWidth, placeLabel } from './lib/retrain-label-place.js'
import type { EditorBox } from './lib/retrain-editor.js'
import {
  boxToPixelRect,
  normToPixel,
  panBy,
  pixelToNorm,
  viewportImageRect,
  zoomAt,
} from './lib/retrain-zoom.js'
import { isTypingTarget } from './lib/retrain-shortcuts.js'
import {
  boxLook,
  DIMMED_OPACITY,
  EMPHASIS_EXTRA_PX,
  ORIGIN_GHOST_OPACITY,
} from './lib/retrain-box-look.js'
import { emphasisOf, type Hover, hoverFromCanvas, sameHover } from './lib/retrain-hover.js'
import { fallbackKind, type LiveReview } from './lib/retrain-live-review.js'

/** Hit area of a resize handle, in SCREEN pixels each side — finger-sized. */
export const HANDLE_HIT_PX = 12

/** Wheel delta → zoom factor. A standard notch (100) is ~1.16x. */
const WHEEL_ZOOM_RATE = 0.0015

interface RetrainCanvasProps {
  readonly imageSrc: string
  readonly imageWidth: number
  readonly imageHeight: number
  readonly boxes: readonly EditorBox[]
  readonly selectedKey: string | null
  /** The visible part of the frame (`lib/retrain-zoom.ts`). */
  readonly viewport: NormBox
  readonly onViewportChange: (viewport: NormBox) => void
  /** Pan tool on: a one-finger / left-button drag pans instead of drawing. */
  readonly panMode: boolean
  readonly onSelect: (key: string | null) => void
  readonly onDraw: (box: NormBox) => void
  /** A move/resize begins — the page opens one undo step. */
  readonly onGestureStart: () => void
  /** The box's live geometry during the gesture. */
  readonly onGestureBox: (key: string, bbox: NormBox) => void
  readonly onGestureEnd: () => void
  /** The live review diff — absent on a bare canvas (every box then falls back to its kind). */
  readonly review?: LiveReview | null
  /** Draw the proposals the operator deleted, as dotted ghosts. */
  readonly showRemoved?: boolean
  /** The hovered box (list or canvas), lives outside the undo history. */
  readonly hover?: Hover | null
  readonly onHover?: (hover: Hover | null) => void
}

interface Point {
  readonly x: number
  readonly y: number
}

/** What the pointer(s) are doing right now. */
type Interaction =
  | { readonly mode: 'none' }
  | { readonly mode: 'draw'; readonly start: Point }
  | { readonly mode: 'move'; readonly key: string; readonly start: Point; readonly from: NormBox }
  | {
      readonly mode: 'resize'
      readonly key: string
      readonly handle: ResizeHandle
      readonly from: NormBox
    }
  | { readonly mode: 'pan'; readonly startPx: Point; readonly from: NormBox }
  | {
      readonly mode: 'pinch'
      readonly startDistance: number
      readonly anchor: Point
      readonly from: NormBox
    }

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function RetrainCanvas({
  imageSrc,
  imageWidth,
  imageHeight,
  boxes,
  selectedKey,
  viewport,
  onViewportChange,
  panMode,
  onSelect,
  onDraw,
  onGestureStart,
  onGestureBox,
  onGestureEnd,
  review = null,
  showRemoved = true,
  hover = null,
  onHover,
}: RetrainCanvasProps) {
  const { t } = useT()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [container, setContainer] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [drawing, setDrawing] = useState<NormBox | null>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const pointers = useRef(new Map<number, Point>())
  const interaction = useRef<Interaction>({ mode: 'none' })

  // Measured, not assumed: the pane is responsive and the letterbox geometry
  // changes with it, so a size captured once would misplace every box after the
  // first resize.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (el === null) return
    const measure = (): void => setContainer({ w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [])

  const image: PixelRect | null = displayedImageRect(
    container.w,
    container.h,
    imageWidth,
    imageHeight,
  )

  // Space held = temporary pan, as in every image editor. Only while nobody
  // is typing: a space in a label field is a space.
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key !== ' ' || isTypingTarget(event.target)) return
      event.preventDefault()
      setSpaceHeld(true)
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key === ' ') setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // The wheel needs a NON-passive listener to keep the page from scrolling
  // while it zooms; React's synthetic wheel handler cannot preventDefault.
  const wheelState = useRef({ image, viewport, onViewportChange })
  wheelState.current = { image, viewport, onViewportChange }
  useEffect(() => {
    const el = containerRef.current
    if (el === null) return undefined
    const onWheel = (event: WheelEvent): void => {
      const { image: img, viewport: vp, onViewportChange: change } = wheelState.current
      if (img === null) return
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const anchor = pixelToNorm(event.clientX - rect.left, event.clientY - rect.top, img, vp)
      change(zoomAt(vp, anchor, Math.exp(-event.deltaY * WHEEL_ZOOM_RATE)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
    }
  }, [])

  const localPoint = useCallback((event: { clientX: number; clientY: number }): Point => {
    const rect = containerRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }, [])

  const toNorm = useCallback(
    (px: Point): Point | null => (image === null ? null : pixelToNorm(px.x, px.y, image, viewport)),
    [image, viewport],
  )

  const finishGesture = useCallback(() => {
    const current = interaction.current
    if (current.mode === 'move' || current.mode === 'resize') onGestureEnd()
    if (current.mode === 'draw') setDrawing(null)
    interaction.current = { mode: 'none' }
  }, [onGestureEnd])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (image === null) return
    const px = localPoint(event)
    pointers.current.set(event.pointerId, px)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    if (pointers.current.size === 2) {
      // A second finger turns whatever the first one started into a pinch.
      finishGesture()
      const [a, b] = [...pointers.current.values()]
      if (a === undefined || b === undefined) return
      const mid = midpoint(a, b)
      interaction.current = {
        mode: 'pinch',
        startDistance: Math.max(1, distance(a, b)),
        anchor: pixelToNorm(mid.x, mid.y, image, viewport),
        from: viewport,
      }
      return
    }
    if (pointers.current.size > 2) return
    if (event.button === 1 || spaceHeld || panMode) {
      event.preventDefault()
      interaction.current = { mode: 'pan', startPx: px, from: viewport }
      return
    }
    if (event.button !== 0) return
    const point = pixelToNorm(px.x, px.y, image, viewport)
    const tolerance = {
      x: (HANDLE_HIT_PX / image.width) * viewport.w,
      y: (HANDLE_HIT_PX / image.height) * viewport.h,
    }
    const selected = boxes.find((b) => b.key === selectedKey)
    if (selected !== undefined) {
      const hit = handleAtPoint(selected.bbox, point, tolerance)
      if (hit !== null && hit !== 'body') {
        onGestureStart()
        interaction.current = {
          mode: 'resize',
          key: selected.key,
          handle: hit,
          from: selected.bbox,
        }
        return
      }
    }
    const index = boxAtPoint(
      boxes.map((b) => b.bbox),
      point,
    )
    const under = boxes[index]
    if (under !== undefined) {
      if (under.key !== selectedKey) onSelect(under.key)
      onGestureStart()
      interaction.current = { mode: 'move', key: under.key, start: point, from: under.bbox }
      return
    }
    interaction.current = { mode: 'draw', start: point }
    setDrawing(dragToBox(point, point))
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (image === null) return
    if (!pointers.current.has(event.pointerId)) {
      // Nothing pressed: a mouse or pen hovering. Touch has no hover.
      if (event.pointerType === 'touch' || onHover === undefined) return
      const px = localPoint(event)
      const point = pixelToNorm(px.x, px.y, image, viewport)
      const next = hoverFromCanvas(boxes, point)
      if (!sameHover(next, hover)) onHover(next)
      return
    }
    const px = localPoint(event)
    pointers.current.set(event.pointerId, px)
    const current = interaction.current
    switch (current.mode) {
      case 'pinch': {
        const [a, b] = [...pointers.current.values()]
        if (a === undefined || b === undefined) return
        const zoomed = zoomAt(current.from, current.anchor, distance(a, b) / current.startDistance)
        // Keep the pinched point under the fingers' midpoint as it moves.
        const mid = midpoint(a, b)
        const now = pixelToNorm(mid.x, mid.y, image, zoomed)
        onViewportChange(panBy(zoomed, current.anchor.x - now.x, current.anchor.y - now.y))
        return
      }
      case 'pan': {
        const dx = ((px.x - current.startPx.x) / image.width) * current.from.w
        const dy = ((px.y - current.startPx.y) / image.height) * current.from.h
        onViewportChange(panBy(current.from, -dx, -dy))
        return
      }
      case 'move': {
        const point = pixelToNorm(px.x, px.y, image, viewport)
        onGestureBox(
          current.key,
          moveBox(current.from, point.x - current.start.x, point.y - current.start.y),
        )
        return
      }
      case 'resize': {
        const point = pixelToNorm(px.x, px.y, image, viewport)
        onGestureBox(current.key, resizeBox(current.from, current.handle, point))
        return
      }
      case 'draw': {
        const point = pixelToNorm(px.x, px.y, image, viewport)
        setDrawing(dragToBox(current.start, point))
        return
      }
      default:
        return
    }
  }

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.delete(event.pointerId)
    const current = interaction.current
    if (current.mode === 'pinch') {
      // The pinch ends when the first finger lifts; the other one does nothing.
      if (pointers.current.size < 2) interaction.current = { mode: 'none' }
      return
    }
    if (current.mode === 'draw') {
      const end = toNorm(localPoint(event))
      const drawn = end === null ? null : dragToBox(current.start, end)
      setDrawing(null)
      interaction.current = { mode: 'none' }
      // Below the minimum it was a CLICK on empty frame, not a rectangle: it
      // deselects instead of storing a 3-pixel label nothing can learn from.
      if (drawn !== null && isDrawnBox(drawn)) onDraw(drawn)
      else onSelect(null)
      return
    }
    finishGesture()
  }

  const selected = boxes.find((b) => b.key === selectedKey)
  const panning = spaceHeld || panMode
  const boxEls = useRef(new Map<string, HTMLDivElement>())
  // A box picked from the keyboard (Tab, arrows) takes DOM focus too, so the
  // screen reader follows; a pointer-picked one does not steal focus from the
  // list the operator is working in.
  useEffect(() => {
    if (selectedKey === null) return
    const active = document.activeElement
    const free =
      active === null || active === document.body || containerRef.current?.contains(active)
    if (free === true) boxEls.current.get(selectedKey)?.focus({ preventScroll: true })
  }, [selectedKey])
  const imageRect = image === null ? null : viewportImageRect(image, viewport)

  return (
    <div
      ref={containerRef}
      data-testid="retrain-canvas"
      className="relative min-h-0 w-full flex-1 bg-background select-none touch-none overflow-hidden"
      style={{ cursor: panning ? 'grab' : hover !== null ? 'move' : 'crosshair' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => {
        if (hover?.source === 'canvas') onHover?.(null)
      }}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {imageRect !== null && (
        // eslint-disable-next-line @next/next/no-img-element -- a data URI of one frame
        <img
          src={imageSrc}
          alt={t('canvas.frameAlt')}
          draggable={false}
          className="absolute max-w-none pointer-events-none"
          style={imageRect}
        />
      )}
      {image !== null &&
        showRemoved &&
        (review?.removed ?? []).map((ghost) => (
          <GhostBox
            key={`removed-${ghost.ref}`}
            ghost={ghost}
            rect={boxToPixelRect(ghost.bbox, image, viewport)}
            bounds={image}
            dimmed={hover !== null}
          />
        ))}
      {image !== null &&
        boxes.map((box) => {
          const rect = boxToPixelRect(box.bbox, image, viewport)
          const diff = review?.byKey.get(box.key)
          const kind = diff?.kind ?? fallbackKind(box)
          const look = boxLook(kind)
          const isSelected = box.key === selectedKey
          const emphasis = emphasisOf(box.key, hover)
          const width =
            look.strokeWidth + (isSelected || emphasis === 'hovered' ? EMPHASIS_EXTRA_PX : 0)
          const name = box.label ?? box.macroClass
          const tagText = `${name}${box.kind === 'model_error' ? ' ✕' : ''}${box.flag !== undefined && box.flag.verdict !== 'confirmed' ? ' !' : ''}`
          const place = placeLabel(rect, estimateLabelWidth(tagText), image)
          return (
            <div key={box.key}>
              {emphasis === 'hovered' && diff?.originBbox !== undefined && (
                <div
                  data-testid={`retrain-origin-${box.key}`}
                  aria-hidden="true"
                  className="absolute pointer-events-none"
                  // ui-check-ok: computed geometry + the diff stroke token
                  style={{
                    ...boxToPixelRect(diff.originBbox, image, viewport),
                    border: `1px dashed ${look.stroke}`,
                    opacity: ORIGIN_GHOST_OPACITY,
                  }}
                />
              )}
              <div
                ref={(el) => {
                  if (el === null) boxEls.current.delete(box.key)
                  else boxEls.current.set(box.key, el)
                }}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={`${name}, ${kind}, ${t(`source.${box.source}`)}`}
                data-testid={`retrain-box-${box.key}`}
                data-draft={box.draft ? 'true' : 'false'}
                data-source={box.source}
                data-kind={kind}
                data-emphasis={emphasis}
                className="absolute pointer-events-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                onFocus={() => {
                  if (!isSelected) onSelect(box.key)
                }}
                // ui-check-ok: computed geometry + the diff stroke token
                style={{
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  border: `${String(width)}px ${look.strokeStyle} ${look.stroke}`,
                  boxShadow: isSelected ? '0 0 0 1px var(--color-background)' : undefined,
                  opacity: emphasis === 'dimmed' ? DIMMED_OPACITY : 1,
                }}
              >
                <span
                  className={`absolute flex items-center gap-1 whitespace-nowrap rounded px-1 text-[11px] font-medium leading-4 ${place.anchor === 'right' ? 'right-0' : 'left-0'} ${place.row === 'inside' ? 'top-0' : '-top-5'}`}
                  // ui-check-ok: the label pair of the diff: fill / on tokens, per box
                  style={{
                    background: look.labelBackground,
                    color: look.labelColor,
                    border: `1px solid ${look.labelBorder}`,
                  }}
                >
                  <RetrainSourceIcon source={box.source} size={11} />
                  {name}
                  {box.kind === 'model_error' ? ' ✕' : ''}
                  {box.flag !== undefined && box.flag.verdict !== 'confirmed' ? ' !' : ''}
                </span>
              </div>
            </div>
          )
        })}
      {image !== null &&
        selected !== undefined &&
        RESIZE_HANDLES.map((handle) => {
          const at = normToPixel(handlePoint(selected.bbox, handle), image, viewport)
          return (
            <div
              key={handle}
              data-testid={`retrain-handle-${handle}`}
              className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary pointer-events-none"
              style={{ left: at.x, top: at.y }}
            />
          )
        })}
      {drawing !== null && image !== null && (
        <div
          className="absolute border border-dashed border-primary pointer-events-none"
          style={boxToPixelRect(drawing, image, viewport)}
        />
      )}
    </div>
  )
}

interface GhostBoxProps {
  readonly ghost: { readonly ref: string; readonly label: string }
  readonly rect: { left: number; top: number; width: number; height: number }
  readonly bounds: PixelRect
  readonly dimmed: boolean
}

/** A proposal the operator deleted — dotted, in the removed colour, struck through. */
function GhostBox({ ghost, rect, bounds, dimmed }: GhostBoxProps): JSX.Element {
  const look = boxLook('removed')
  const place = placeLabel(rect, estimateLabelWidth(ghost.label), bounds)
  return (
    <div
      data-testid={`retrain-ghost-${ghost.ref}`}
      aria-hidden="true"
      className="absolute pointer-events-none"
      // ui-check-ok: computed geometry + the removed stroke token
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        border: `${String(look.strokeWidth)}px ${look.strokeStyle} ${look.stroke}`,
        opacity: dimmed ? DIMMED_OPACITY : 0.85,
      }}
    >
      <span
        className={`absolute whitespace-nowrap rounded px-1 text-[11px] font-medium leading-4 line-through ${place.anchor === 'right' ? 'right-0' : 'left-0'} ${place.row === 'inside' ? 'top-0' : '-top-5'}`}
        style={{ background: look.labelBackground, color: look.labelColor }} // ui-check-ok: the removed label pair: fill / on tokens
      >
        {ghost.label}
      </span>
    </div>
  )
}
