/**
 * The source camera's own frame with ONE highlighted rectangle: the part a
 * cell (or a crop camera) takes. Shared by the grid editor's per-cell crop and
 * the crop camera editor so there is a single canvas.
 *
 * The whole snapshot is drawn behind a dimmed overlay and the rectangle is the
 * hole in it, so it reads as a window rather than a highlight. The frame is
 * drawn at the camera's OWN aspect (measured from the snapshot), because the
 * rectangle is normalized against the whole frame.
 *
 * The drag state is local; the owner receives the origin rectangle, the
 * normalized delta and the pointer position, and decides how to move or resize.
 */
import { useState, type JSX } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { useDeviceSnapshotImage } from '../../hooks/use-device-snapshot.js'
import { type GridNormalizedRect, type GridResizeHandle } from './camera-grid-layout.js'

/**
 * A rectangle being dragged must not also PAN THE PAGE.
 *
 * On a phone a pointerdown on a `div` is a scroll gesture until the browser is
 * told otherwise, and `preventDefault` in the handler is too late — the browser
 * has already decided. `touch-action: none` is the only thing that makes a drag
 * work with a finger, and every surface that starts one carries it.
 */
export const DRAG_SURFACE = { touchAction: 'none' } as const

/**
 * Finger-sized hit area around a grip.
 *
 * The visible square stays small (it sits ON the picture being edited and a big
 * one hides what it is positioning); the TOUCHABLE box around it is 24px, which
 * is the smallest target size that does not need a fingernail. The two are
 * different boxes on purpose — making the dot itself 24px would cover a quarter
 * of a small cell.
 */
export const HANDLE_HIT = 'absolute flex h-6 w-6 items-center justify-center'

/** The eight grips, in the order they are drawn. */
export const HANDLES: readonly GridResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export const HANDLE_STYLE: Readonly<Record<GridResizeHandle, string>> = {
  nw: '-top-3 -left-3 cursor-nw-resize',
  n: '-top-3 left-1/2 -translate-x-1/2 cursor-n-resize',
  ne: '-top-3 -right-3 cursor-ne-resize',
  e: 'top-1/2 -right-3 -translate-y-1/2 cursor-e-resize',
  se: '-bottom-3 -right-3 cursor-se-resize',
  s: '-bottom-3 left-1/2 -translate-x-1/2 cursor-s-resize',
  sw: '-bottom-3 -left-3 cursor-sw-resize',
  w: 'top-1/2 -left-3 -translate-y-1/2 cursor-w-resize',
}

/**
 * Start a drag and KEEP it, even when the finger leaves the rectangle.
 *
 * Without pointer capture a drag ends the moment the pointer crosses the box it
 * started in — which on a phone is immediately, because the box is small and
 * the finger is not. With capture the events keep coming to the element that
 * was grabbed and still bubble to the canvas that does the arithmetic.
 */
export function capturePointer(event: React.PointerEvent<HTMLElement>): void {
  event.currentTarget.setPointerCapture(event.pointerId)
}

export interface SourceCropDrag {
  readonly mode: 'move' | GridResizeHandle
  /** The rectangle when the drag started. */
  readonly origin: GridNormalizedRect
  /** Pointer travel since the start, as a fraction of the frame. */
  readonly dx: number
  readonly dy: number
  /** The pointer, in the frame's normalized space. */
  readonly point: { readonly x: number; readonly y: number }
  /** The frame's width / height (16/9 until the snapshot has loaded). */
  readonly sourceAspect: number
}

export interface SourceCropCanvasProps {
  readonly deviceId: number
  readonly rect: GridNormalizedRect
  /** Grips to draw; all eight by default. */
  readonly handles?: readonly GridResizeHandle[]
  readonly onDrag: (drag: SourceCropDrag) => void
  /** Called once the snapshot has told the frame's real aspect. */
  readonly onSourceAspect?: (aspect: number) => void
}

interface ActiveDrag {
  readonly mode: 'move' | GridResizeHandle
  readonly startX: number
  readonly startY: number
  readonly origin: GridNormalizedRect
}

export function SourceCropCanvas({
  deviceId,
  rect,
  handles = HANDLES,
  onDrag,
  onSourceAspect,
}: SourceCropCanvasProps): JSX.Element {
  const t = useUiText()
  const { src } = useDeviceSnapshotImage(deviceId, { width: 640 })
  const [drag, setDrag] = useState<ActiveDrag | null>(null)
  const [sourceAspect, setSourceAspect] = useState<number | null>(null)

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag === null) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0) return
    onDrag({
      mode: drag.mode,
      origin: drag.origin,
      dx: (event.clientX - drag.startX) / bounds.width,
      dy: (event.clientY - drag.startY) / bounds.height,
      point: {
        x: (event.clientX - bounds.left) / bounds.width,
        y: (event.clientY - bounds.top) / bounds.height,
      },
      sourceAspect: sourceAspect ?? 16 / 9,
    })
  }

  const start = (mode: 'move' | GridResizeHandle, event: React.PointerEvent<HTMLElement>): void => {
    capturePointer(event)
    setDrag({
      mode,
      startX: event.clientX,
      startY: event.clientY,
      origin: rect,
    })
  }

  return (
    <div
      className="relative w-full select-none overflow-hidden rounded border border-border bg-black"
      style={{ aspectRatio: String(sourceAspect ?? 16 / 9), ...DRAG_SURFACE }} // ui-check-ok: computed geometry (percent of the frame) / touch-action
      data-testid="source-crop-canvas"
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        setDrag(null)
      }}
      onPointerCancel={() => {
        setDrag(null)
      }}
    >
      {src === null ? (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-foreground-subtle">
          {t(
            'uiLibrary.cameraGridLayout.noSnapshot',
            'No snapshot from this camera yet — the numbers below still apply.',
          )}
        </div>
      ) : (
        <img
          src={src}
          alt=""
          className="absolute inset-0 h-full w-full"
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget
            if (naturalWidth > 0 && naturalHeight > 0) {
              const aspect = naturalWidth / naturalHeight
              setSourceAspect(aspect)
              onSourceAspect?.(aspect)
            }
          }}
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-black/55" />
      <div
        role="presentation"
        data-testid="source-crop-rect"
        onPointerDown={(event) => {
          start('move', event)
        }}
        className="absolute cursor-move border border-primary"
        style={{
          // ui-check-ok: computed geometry (percent of the frame) / touch-action
          ...DRAG_SURFACE,
          left: `${String(rect.x * 100)}%`,
          top: `${String(rect.y * 100)}%`,
          width: `${String(rect.width * 100)}%`,
          height: `${String(rect.height * 100)}%`,
          backgroundImage: src === null ? undefined : `url(${src})`,
          backgroundSize: `${String(100 / rect.width)}% ${String(100 / rect.height)}%`,
          backgroundPosition:
            rect.width >= 1 && rect.height >= 1
              ? 'center'
              : `${String((rect.x / Math.max(1e-6, 1 - rect.width)) * 100)}% ` +
                `${String((rect.y / Math.max(1e-6, 1 - rect.height)) * 100)}%`,
        }}
      >
        {handles.map((handle) => (
          <div
            key={handle}
            role="presentation"
            data-testid={`source-crop-handle-${handle}`}
            onPointerDown={(event) => {
              event.stopPropagation()
              start(handle, event)
            }}
            className={`${HANDLE_HIT} ${HANDLE_STYLE[handle]}`}
            style={DRAG_SURFACE} // ui-check-ok: computed geometry (percent of the frame) / touch-action
          >
            <span className="h-2.5 w-2.5 bg-primary" />
          </div>
        ))}
      </div>
    </div>
  )
}
