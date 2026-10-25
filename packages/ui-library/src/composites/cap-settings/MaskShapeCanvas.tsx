/**
 * MaskShapeCanvas — ONE shared, Konva-based on-frame "drawing plane" editor
 * that handles ALL four `MaskShape` kinds: `rect`, `polygon`, `grid`, `line`.
 *
 * It is a generalization of the detection `ZoneCanvas` (orchestrator) so that
 * privacy-mask (rect/polygon), motion-zones (grid), and the
 * pipeline-orchestrator zones/lines editor can eventually all share a single
 * editor instead of three bespoke ones. Every coordinate is normalized 0..1 of
 * the camera frame (top-left origin), like every existing on-frame editor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Behaviours ported (the references are NOT edited — this generalizes them):
 *
 *   - From `ZoneCanvas` (orchestrator zone-editor):
 *       • ResizeObserver-sized `<Stage>`, `transparent` absolute-fill overlay
 *         mode for layering over a stream player, optional `backdrop` slot,
 *         pointer-events pass-through while not editing.
 *       • polygon draw / vertex-drag / body-drag with optimistic local override
 *         + the `useEffect` that drops the override once the controlled prop
 *         echoes the commit back, the rAF-throttled cursor ghost-line preview,
 *         the `Arrow` tripwire, and the memoised export.
 *   - From `PrivacyMaskCanvas`:
 *       • rect move + bottom-right-handle resize with 0..1 clamp, polygon
 *         vertex add (edge midpoint) / remove (✕, gated by min/max), and the
 *         `polygonVertices` {min,max} gate (e.g. Hikvision {min:4,max:4}).
 *   - From `MotionGridCanvas`:
 *       • grid cell-paint gesture (press-drag paints every touched cell to the
 *         value the first-touched cell flipped to), row-major `cells`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage — each consumer maps its own model onto `MaskShapeItem[]` and gates the
 * editor with `supportedShapes`:
 *
 * @example privacy-mask (rect + polygon)
 * ```tsx
 * const items: MaskShapeItem[] = regions.map((r) => ({ id: r.id, shape: r.shape }))
 * <MaskShapeCanvas
 *   transparent
 *   items={items}
 *   supportedShapes={['rect', 'polygon']}
 *   polygonVertices={options.polygonVertices}        // Hikvision {min:4,max:4}
 *   selectedId={selectedId}
 *   onSelect={setSelectedId}
 *   onShapeChange={(id, shape) =>
 *     onRegionsChange(regions.map((r) => (r.id === id ? { ...r, shape } : r)))}
 *   onDrawComplete={(shape) => onRegionsChange([...regions, { id: nextId(), shape }])}
 *   drawingKind={drawing ? 'rect' : null}
 * />
 * ```
 *
 * @example motion-zones (grid)
 * ```tsx
 * const items: MaskShapeItem[] = [{
 *   id: 'motion',
 *   shape: { kind: 'grid', gridWidth: w, gridHeight: h, cells },
 * }]
 * <MaskShapeCanvas
 *   transparent
 *   items={items}
 *   supportedShapes={['grid']}
 *   grid={{ width: w, height: h }}
 *   selectedId="motion"
 *   onSelect={() => {}}
 *   onShapeChange={(_id, shape) => {
 *     if (shape.kind === 'grid') onCellsChange(shape.cells)
 *   }}
 *   onDrawComplete={() => {}}
 *   drawingKind={null}
 * />
 * ```
 *
 * @example orchestrator (polygon + line/tripwire)
 * ```tsx
 * const items: MaskShapeItem[] = zones.map((z) => ({
 *   id: z.id,
 *   label: z.name,
 *   color: z.color,
 *   shape: z.kind === 'tripwire'
 *     ? { kind: 'line', points: z.points }
 *     : { kind: 'polygon', points: z.points },
 * }))
 * <MaskShapeCanvas
 *   transparent
 *   items={items}
 *   supportedShapes={['polygon', 'line']}
 *   selectedId={selectedZoneId}
 *   onSelect={onSelectZone}
 *   onShapeChange={(id, shape) => {
 *     if (shape.kind === 'polygon' || shape.kind === 'line')
 *       onZonePointsChange(id, shape.points)
 *   }}
 *   onDrawComplete={(shape) => onZoneComplete(shape)}
 *   drawingKind={drawingKind === 'tripwire' ? 'line' : drawingKind}
 *   backdrop={<CameraStreamPlayer ... />}
 * />
 * ```
 *
 * Purely controlled — the parent owns the truth. Every edit fires
 * `onShapeChange(id, shape)` (or `onDrawComplete(shape)` for a freshly-drawn
 * shape) with a brand-new immutable shape object; points and cells are never
 * mutated in place.
 */
import { useUiText } from '../../contexts/ui-text'
import {
  memo,
  useRef,
  useState,
  useEffect,
  useCallback,
  type JSX,
  type MemoExoticComponent,
  type ReactNode,
} from 'react'
import { Stage, Layer, Line, Rect, Circle, Text, Group, Arrow } from 'react-konva'
import type Konva from 'konva'
import type { MaskShape, MaskShapeKind, MaskPoint } from '@camstack/types'

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** One editable item on the drawing plane. */
export interface MaskShapeItem {
  readonly id: string | number
  readonly shape: MaskShape
  /** Small text label rendered near the shape. */
  readonly label?: string
  /** Stroke/fill color. Falls back to a sensible per-kind default. */
  readonly color?: string
  /** `false` → rendered dimmed (and skipped for hit-testing of editing chrome). */
  readonly enabled?: boolean
}

export interface MaskShapeCanvasProps {
  readonly items: MaskShapeItem[]
  readonly selectedId: string | number | null
  readonly onSelect: (id: string | number | null) => void
  /** Fired on every edit (controlled — parent owns truth, immutable updates). */
  readonly onShapeChange: (id: string | number, shape: MaskShape) => void
  /** Fired when a new shape is finished while drawing. */
  readonly onDrawComplete: (shape: MaskShape) => void
  /** When set, clicks draw a new shape of that kind. */
  readonly drawingKind: MaskShapeKind | null
  /** Which kinds this mount allows. */
  readonly supportedShapes: readonly MaskShapeKind[]
  /** Transparent absolute-fill overlay mode (layer over a stream player). */
  readonly transparent?: boolean
  /** Backdrop element rendered behind the Stage in standalone mode. */
  readonly backdrop?: ReactNode
  /** Gate polygon vertex add/remove (e.g. Hikvision {min:4,max:4}). */
  readonly polygonVertices?: { readonly min: number; readonly max: number }
  /** Grid dims when drawing/seeding a `grid` shape. */
  readonly grid?: { readonly width: number; readonly height: number }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind default colors + constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_COLOR: Record<MaskShapeKind, string> = {
  rect: '#ef4444', // red — "blanked out" (privacy mask)
  polygon: '#3b82f6', // blue — detection zone
  grid: '#6366f1', // indigo — motion lattice
  line: '#f59e0b', // amber — tripwire
}

/** Polygon body fill alpha (hex suffix). `#33` ≈ 20%, `#66` ≈ 40%. */
const FILL_ALPHA = '33'
const FILL_ALPHA_SELECTED = '66'

const DRAW_PREVIEW_STROKE = '#6366f1'
const FLOOR_POLYGON_VERTICES = 3
const FLOOR_LINE_VERTICES = 2
const CLOSE_HIT_RADIUS = 12

// Standalone-mode visual-rhythm grid (NOT the editable `grid` shape).
const RHYTHM_COLS = 16
const RHYTHM_ROWS = 9

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toCanvas(p: MaskPoint, w: number, h: number): { x: number; y: number } {
  return { x: p.x * w, y: p.y * h }
}

function toNorm(p: { x: number; y: number }, w: number, h: number): MaskPoint {
  return { x: p.x / w, y: p.y / h }
}

function flatPoints(points: readonly MaskPoint[], w: number, h: number): number[] {
  return points.flatMap((p) => [p.x * w, p.y * h])
}

/** Clamp to the normalized 0..1 range, mapping non-finite values to 0. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

function resolveColor(item: MaskShapeItem): string {
  return item.color ?? DEFAULT_COLOR[item.shape.kind]
}

/** Insert a vertex at the midpoint of edge `edgeStart → edgeStart+1`. */
function insertMidpoint(points: readonly MaskPoint[], edgeStart: number): MaskPoint[] {
  const a = points[edgeStart]
  const b = points[(edgeStart + 1) % points.length]
  if (!a || !b) return [...points]
  const mid: MaskPoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  return [...points.slice(0, edgeStart + 1), mid, ...points.slice(edgeStart + 1)]
}

/** Float-tolerant point-list equality (used to detect prop catch-up). */
function pointsEqual(a: readonly MaskPoint[], b: readonly MaskPoint[]): boolean {
  if (a.length !== b.length) return false
  return a.every((p, i) => {
    const o = b[i]!
    return Math.abs(p.x - o.x) < 1e-6 && Math.abs(p.y - o.y) < 1e-6
  })
}

/**
 * Type guard: a point-based shape (`polygon` | `line`) carries a `points`
 * array. Narrowing here keeps the points editors from re-checking `kind`.
 */
type PointShape = Extract<MaskShape, { points: MaskPoint[] }>
function isPointShape(shape: MaskShape): shape is PointShape {
  return shape.kind === 'polygon' || shape.kind === 'line'
}

// The optimistic drag override holds a live point set for a single item while
// it is being dragged. See ZoneCanvas's `vertexDragOverride` for the rationale:
// (1) avoid a parent round-trip per pointer pixel; (2) avoid a snap-back to the
// pre-drag geometry while the controlled prop catches up to the commit.
interface DragOverride {
  readonly itemId: string | number
  readonly points: readonly MaskPoint[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

function MaskShapeCanvasImpl({
  items,
  selectedId,
  onSelect,
  onShapeChange,
  onDrawComplete,
  drawingKind,
  supportedShapes,
  transparent = false,
  backdrop,
  polygonVertices,
  grid,
}: MaskShapeCanvasProps): JSX.Element {
  const t = useUiText()
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 450 })
  const [drawPoints, setDrawPoints] = useState<MaskPoint[]>([])
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null)
  const [draggingItemId, setDraggingItemId] = useState<string | number | null>(null)
  const [dragOverride, setDragOverride] = useState<DragOverride | null>(null)

  // Drawing is only honoured if the kind is actually allowed by this mount.
  const isDrawing = drawingKind !== null && supportedShapes.includes(drawingKind)

  // Drop the optimistic override once the controlled prop reflects the commit
  // (server echo through the slice subscription). Mirrors ZoneCanvas exactly.
  useEffect(() => {
    if (!dragOverride) return
    const it = items.find((i) => i.id === dragOverride.itemId)
    if (!it || !isPointShape(it.shape)) {
      setDragOverride(null)
      return
    }
    if (pointsEqual(it.shape.points, dragOverride.points)) setDragOverride(null)
  }, [items, dragOverride])

  // ResizeObserver. Standalone: derive height as width × 9/16. Overlay: size to
  // the parent's content rect (the player owns aspect). Mirrors ZoneCanvas.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setSize(transparent ? { w: width, h: height } : { w: width, h: (width * 9) / 16 })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [transparent])

  // Clear the ghost cursor when drawing ends so no stale preview lingers.
  useEffect(() => {
    if (!isDrawing && cursorPos !== null) setCursorPos(null)
  }, [isDrawing, cursorPos])

  // ── Drawing ────────────────────────────────────────────────────────────────

  const completeDraw = useCallback(
    (shape: MaskShape): void => {
      onDrawComplete(shape)
      setDrawPoints([])
    },
    [onDrawComplete],
  )

  const handleStageClick = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (!isDrawing || drawingKind === null) {
        onSelect(null)
        return
      }
      const stage = e.target.getStage()
      if (!stage) return
      const pos = stage.getPointerPosition()
      if (!pos) return
      const norm = toNorm(pos, size.w, size.h)

      // rect — one click drops a small default rect (resize via the handle).
      if (drawingKind === 'rect') {
        const x = clamp01(norm.x)
        const y = clamp01(norm.y)
        completeDraw({
          kind: 'rect',
          x,
          y,
          width: Math.min(0.2, 1 - x),
          height: Math.min(0.2, 1 - y),
        })
        return
      }

      // grid — one click drops an all-false lattice of the configured dims.
      if (drawingKind === 'grid') {
        const gw = grid?.width ?? RHYTHM_COLS
        const gh = grid?.height ?? RHYTHM_ROWS
        completeDraw({
          kind: 'grid',
          gridWidth: gw,
          gridHeight: gh,
          cells: Array.from({ length: gw * gh }, () => false),
        })
        return
      }

      // line/tripwire — two clicks.
      if (drawingKind === 'line') {
        if (drawPoints.length === 0) {
          setDrawPoints([norm])
          return
        }
        completeDraw({ kind: 'line', points: [...drawPoints, norm] })
        return
      }

      // polygon — click to add; click near the first point (≥3) to close.
      if (drawingKind === 'polygon') {
        if (drawPoints.length === 0) {
          setDrawPoints([norm])
          return
        }
        if (drawPoints.length >= FLOOR_POLYGON_VERTICES) {
          const first = toCanvas(drawPoints[0]!, size.w, size.h)
          if (Math.hypot(pos.x - first.x, pos.y - first.y) < CLOSE_HIT_RADIUS) {
            completeDraw({ kind: 'polygon', points: drawPoints })
            return
          }
        }
        setDrawPoints((prev) => [...prev, norm])
      }
    },
    [isDrawing, drawingKind, drawPoints, size, grid, completeDraw, onSelect],
  )

  const handleDblClick = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (!isDrawing || drawingKind !== 'polygon') return
      if (drawPoints.length < FLOOR_POLYGON_VERTICES) return
      e.cancelBubble = true
      completeDraw({ kind: 'polygon', points: drawPoints })
    },
    [isDrawing, drawingKind, drawPoints, completeDraw],
  )

  // Cursor ghost-line — rAF-throttled, only active while drawing. Mirrors
  // ZoneCanvas's throttle so high-rate pointer moves don't thrash the Stage.
  const cursorRafRef = useRef<number | null>(null)
  const pendingCursorRef = useRef<{ x: number; y: number } | null>(null)
  useEffect(
    () => () => {
      if (cursorRafRef.current !== null) cancelAnimationFrame(cursorRafRef.current)
    },
    [],
  )
  const handleMouseMove = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (!isDrawing) return
      const stage = e.target.getStage()
      if (!stage) return
      pendingCursorRef.current = stage.getPointerPosition() ?? null
      if (cursorRafRef.current !== null) return
      cursorRafRef.current = requestAnimationFrame(() => {
        cursorRafRef.current = null
        setCursorPos(pendingCursorRef.current)
      })
    },
    [isDrawing],
  )

  // ── Grid cell-paint (ported from MotionGridCanvas) ──────────────────────────
  // Active only while a grid item is selected. The paint gesture writes through
  // `onShapeChange` so the parent owns the cells; a ref dedupes cell re-entry.
  const paintingRef = useRef(false)
  const paintValueRef = useRef(true)
  const paintedRef = useRef<Set<number>>(new Set())

  const paintCell = useCallback(
    (
      itemId: string | number,
      shape: Extract<MaskShape, { kind: 'grid' }>,
      index: number,
      value: boolean,
    ): void => {
      const total = shape.gridWidth * shape.gridHeight
      if (index < 0 || index >= total) return
      if (shape.cells[index] === value) return
      const next = [...shape.cells]
      while (next.length < total) next.push(false)
      next.length = total
      next[index] = value
      onShapeChange(itemId, { ...shape, cells: next })
    },
    [onShapeChange],
  )

  // ── Rhythm grid lines (standalone only) ─────────────────────────────────────
  const rhythmLines: ReactNode[] = []
  if (!transparent) {
    for (let i = 1; i < RHYTHM_COLS; i++) {
      const x = (size.w / RHYTHM_COLS) * i
      rhythmLines.push(
        <Line
          key={`gv-${i}`}
          points={[x, 0, x, size.h]}
          stroke="#ffffff"
          strokeWidth={0.5}
          opacity={0.08}
        />,
      )
    }
    for (let i = 1; i < RHYTHM_ROWS; i++) {
      const y = (size.h / RHYTHM_ROWS) * i
      rhythmLines.push(
        <Line
          key={`gh-${i}`}
          points={[0, y, size.w, y]}
          stroke="#ffffff"
          strokeWidth={0.5}
          opacity={0.08}
        />,
      )
    }
  }

  const containerClassName = transparent
    ? 'absolute inset-0'
    : 'relative w-full bg-zinc-900 rounded-lg overflow-hidden'

  return (
    <div
      ref={containerRef}
      className={containerClassName}
      style={{ cursor: isDrawing ? 'crosshair' : 'default' }}
    >
      {backdrop && !transparent ? (
        <div
          className="absolute inset-0 pointer-events-none [&>*]:w-full [&>*]:h-full [&>img]:object-cover [&>video]:object-cover"
          style={{ width: size.w, height: size.h }}
        >
          {backdrop}
        </div>
      ) : null}

      <Stage
        width={size.w}
        height={size.h}
        onClick={handleStageClick}
        onDblClick={handleDblClick}
        onMouseMove={handleMouseMove}
      >
        {/* Non-interactive backdrop + rhythm grid. */}
        <Layer listening={false}>
          <Line
            points={[0, 0, size.w, 0, size.w, size.h, 0, size.h, 0, 0]}
            stroke="transparent"
            strokeWidth={0}
          />
          {rhythmLines}
        </Layer>

        {/* Items. */}
        <Layer>
          {items.map((item) => {
            const selected = item.id === selectedId
            const dimmed = item.enabled === false
            const color = resolveColor(item)
            const editable = selected && !isDrawing && !dimmed

            if (item.shape.kind === 'rect') {
              return (
                <RectItem
                  key={item.id}
                  item={item}
                  shape={item.shape}
                  color={color}
                  selected={selected}
                  dimmed={dimmed}
                  editable={editable}
                  isDrawing={isDrawing}
                  size={size}
                  onSelect={onSelect}
                  onShapeChange={onShapeChange}
                />
              )
            }

            if (item.shape.kind === 'grid') {
              return (
                <GridItem
                  key={item.id}
                  item={item}
                  shape={item.shape}
                  color={color}
                  dimmed={dimmed}
                  editable={editable}
                  size={size}
                  onSelect={onSelect}
                  paintingRef={paintingRef}
                  paintValueRef={paintValueRef}
                  paintedRef={paintedRef}
                  paintCell={paintCell}
                />
              )
            }

            // polygon | line — both point-based.
            const isLine = item.shape.kind === 'line'
            const minVertices = isLine
              ? FLOOR_LINE_VERTICES
              : Math.max(FLOOR_POLYGON_VERTICES, polygonVertices?.min ?? FLOOR_POLYGON_VERTICES)
            const maxVertices = isLine ? FLOOR_LINE_VERTICES : polygonVertices?.max
            const effectivePoints =
              dragOverride && dragOverride.itemId === item.id
                ? dragOverride.points
                : item.shape.points

            return (
              <PointItem
                key={item.id}
                item={item}
                shape={item.shape}
                color={color}
                selected={selected}
                dimmed={dimmed}
                editable={editable}
                isLine={isLine}
                isDrawing={isDrawing}
                size={size}
                effectivePoints={effectivePoints}
                minVertices={minVertices}
                maxVertices={maxVertices}
                isDragging={draggingItemId === item.id}
                onSelect={onSelect}
                onShapeChange={onShapeChange}
                setDragOverride={setDragOverride}
                setDraggingItemId={setDraggingItemId}
              />
            )
          })}
        </Layer>

        {/* Drawing preview — display-only. */}
        <Layer listening={false}>
          {isDrawing && drawPoints.length > 0 && (
            <Group>
              {drawingKind === 'polygon' && drawPoints.length >= 2 && (
                <Line
                  points={flatPoints(drawPoints, size.w, size.h)}
                  stroke={DRAW_PREVIEW_STROKE}
                  strokeWidth={1.5}
                  dash={[6, 3]}
                  opacity={0.8}
                />
              )}
              {drawingKind === 'line' && drawPoints.length === 1 && cursorPos && (
                <Line
                  points={[
                    drawPoints[0]!.x * size.w,
                    drawPoints[0]!.y * size.h,
                    cursorPos.x,
                    cursorPos.y,
                  ]}
                  stroke={DEFAULT_COLOR.line}
                  strokeWidth={1.5}
                  dash={[6, 3]}
                  opacity={0.7}
                />
              )}
              {drawingKind === 'polygon' && cursorPos && drawPoints.length >= 1 && (
                <Line
                  points={[
                    drawPoints[drawPoints.length - 1]!.x * size.w,
                    drawPoints[drawPoints.length - 1]!.y * size.h,
                    cursorPos.x,
                    cursorPos.y,
                  ]}
                  stroke={DRAW_PREVIEW_STROKE}
                  strokeWidth={1}
                  dash={[4, 4]}
                  opacity={0.5}
                />
              )}
              {drawPoints.map((p, idx) => {
                const cp = toCanvas(p, size.w, size.h)
                const firstClose =
                  idx === 0 &&
                  drawingKind === 'polygon' &&
                  drawPoints.length >= FLOOR_POLYGON_VERTICES
                return (
                  <Circle
                    key={idx}
                    x={cp.x}
                    y={cp.y}
                    radius={firstClose ? 7 : 4}
                    fill={firstClose ? DRAW_PREVIEW_STROKE : '#ffffff'}
                    stroke={DRAW_PREVIEW_STROKE}
                    strokeWidth={1.5}
                    opacity={0.9}
                  />
                )
              })}
            </Group>
          )}
        </Layer>
      </Stage>

      {isDrawing ? (
        <div className="px-3 py-1.5 bg-zinc-800/80 text-[11px] text-zinc-400 border-t border-zinc-700">
          {drawingKind === 'line'
            ? t(
                'uiLibrary.maskShapeCanvas.hintLine',
                'Click to set the start point, click again to complete the line',
              )
            : drawingKind === 'rect'
              ? t(
                  'uiLibrary.maskShapeCanvas.hintRect',
                  'Click to drop a rectangle, then drag the corner to resize',
                )
              : drawingKind === 'grid'
                ? t('uiLibrary.maskShapeCanvas.hintGrid', 'Click to add the grid, then paint cells')
                : drawPoints.length < FLOOR_POLYGON_VERTICES
                  ? t(
                      'uiLibrary.maskShapeCanvas.hintPoints',
                      'Click to add points (min 3). Double-click or click the first point to close.',
                    )
                  : t(
                      'uiLibrary.maskShapeCanvas.hintMore',
                      'Continue adding points. Double-click or click the first point to close.',
                    )}
        </div>
      ) : null}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Rect item — move (body drag) + resize (bottom-right handle), 0..1 clamp.
// Geometry/clamp logic ported from PrivacyMaskCanvas's RectBox.
//
// Mirrors PointItem's drag model so the body, label, and resize handle move
// TOGETHER during BOTH move and resize. A single optimistic local override
// holds the rect's live normalized geometry while a gesture is in flight: the
// body drag (a draggable <Group> wrapping body + label + handle) translates the
// whole figure, and the handle drag rewrites width/height live. Every node is
// rendered from `geom` (override-when-present, prop otherwise) so the chrome
// can never detach. The override is dropped once the controlled prop echoes the
// commit back — exactly like PointItem's `dragOverride` catch-up.
// ─────────────────────────────────────────────────────────────────────────────

const MIN_RECT_DIM = 0.02

interface RectGeom {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Float-tolerant rect equality (used to detect controlled-prop catch-up). */
function rectGeomEqual(a: RectGeom, b: RectGeom): boolean {
  return (
    Math.abs(a.x - b.x) < 1e-6 &&
    Math.abs(a.y - b.y) < 1e-6 &&
    Math.abs(a.width - b.width) < 1e-6 &&
    Math.abs(a.height - b.height) < 1e-6
  )
}

interface RectItemProps {
  readonly item: MaskShapeItem
  readonly shape: Extract<MaskShape, { kind: 'rect' }>
  readonly color: string
  readonly selected: boolean
  readonly dimmed: boolean
  readonly editable: boolean
  readonly isDrawing: boolean
  readonly size: { w: number; h: number }
  readonly onSelect: (id: string | number | null) => void
  readonly onShapeChange: (id: string | number, shape: MaskShape) => void
}

function RectItem({
  item,
  shape,
  color,
  selected,
  dimmed,
  editable,
  isDrawing,
  size,
  onSelect,
  onShapeChange,
}: RectItemProps) {
  // Optimistic local override — the live geometry while a move/resize gesture is
  // in flight, so body + label + handle all render from one source and track the
  // pointer continuously (no parent round-trip per pixel, no snap-back).
  const [override, setOverride] = useState<RectGeom | null>(null)
  const propGeom: RectGeom = { x: shape.x, y: shape.y, width: shape.width, height: shape.height }

  // Drop the override once the controlled prop reflects the commit (server echo
  // through the slice subscription). Mirrors PointItem's catch-up effect.
  useEffect(() => {
    if (override && rectGeomEqual(propGeom, override)) setOverride(null)
  }, [shape.x, shape.y, shape.width, shape.height, override])

  const geom = override ?? propGeom
  const x = geom.x * size.w
  const y = geom.y * size.h
  const w = geom.width * size.w
  const h = geom.height * size.h
  const baseOpacity = dimmed ? 0.35 : selected ? 1 : 0.85

  // Commit the override (or an explicit geometry) up to the parent as a new
  // immutable rect shape, never widening `kind`.
  const commit = (g: RectGeom): void => {
    setOverride(g)
    onShapeChange(item.id, { kind: 'rect', x: g.x, y: g.y, width: g.width, height: g.height })
  }

  // Body drag — EXACTLY like PointItem: the wrapping <Group> starts at offset
  // (0,0); Konva translates it (and its children) live as the pointer moves, so
  // no per-move override is needed (that double-displaced the figure before).
  // `dragBoundFunc` clamps the OFFSET so the rect stays in-stage (offset range
  // [-x .. size-(x+w)]); drag-end adds the delta to the geometry and commits.
  const dragBoundFunc = (pos: { x: number; y: number }): { x: number; y: number } => ({
    x: Math.max(-x, Math.min(size.w - (x + w), pos.x)),
    y: Math.max(-y, Math.min(size.h - (y + h), pos.y)),
  })

  const onBodyDragEnd = (e: Konva.KonvaEventObject<DragEvent>): void => {
    const node = e.target
    const dx = node.x() / size.w
    const dy = node.y() / size.h
    node.position({ x: 0, y: 0 })
    if (dx === 0 && dy === 0) return
    const nx = Math.min(Math.max(0, geom.x + dx), Math.max(0, 1 - geom.width))
    const ny = Math.min(Math.max(0, geom.y + dy), Math.max(0, 1 - geom.height))
    commit({ ...geom, x: nx, y: ny })
  }

  // Resize handle — rewrites width/height live (relative to the fixed top-left),
  // updating the override every move so the body + label resize/track in step.
  const onHandleDragMove = (e: Konva.KonvaEventObject<DragEvent>): void => {
    const node = e.target
    const newW = clamp01(node.x() / size.w - geom.x)
    const newH = clamp01(node.y() / size.h - geom.y)
    setOverride({
      ...geom,
      width: Math.max(MIN_RECT_DIM, Math.min(newW, 1 - geom.x)),
      height: Math.max(MIN_RECT_DIM, Math.min(newH, 1 - geom.y)),
    })
  }

  const onHandleDragEnd = (e: Konva.KonvaEventObject<DragEvent>): void => {
    const node = e.target
    const newW = clamp01(node.x() / size.w - geom.x)
    const newH = clamp01(node.y() / size.h - geom.y)
    commit({
      ...geom,
      width: Math.max(MIN_RECT_DIM, Math.min(newW, 1 - geom.x)),
      height: Math.max(MIN_RECT_DIM, Math.min(newH, 1 - geom.y)),
    })
  }

  return (
    <Group
      onClick={(e) => {
        e.cancelBubble = true
        if (!isDrawing) onSelect(item.id)
      }}
    >
      {/* Body subgroup — rect + label translate together on a body drag. The
          group's own (x,y) is the drag offset, reset to 0 on commit; children
          are positioned in absolute stage coords from `geom`. */}
      <Group
        draggable={editable}
        dragBoundFunc={editable ? dragBoundFunc : undefined}
        onDragEnd={editable ? onBodyDragEnd : undefined}
        onMouseEnter={(e) => {
          if (!editable) return
          const stage = e.target.getStage()
          if (stage) stage.container().style.cursor = 'move'
        }}
        onMouseLeave={(e) => {
          if (!editable) return
          const stage = e.target.getStage()
          if (stage) stage.container().style.cursor = isDrawing ? 'crosshair' : 'default'
        }}
      >
        <Rect
          x={x}
          y={y}
          width={w}
          height={h}
          fill={color + (selected ? FILL_ALPHA_SELECTED : FILL_ALPHA)}
          stroke={color}
          strokeWidth={selected ? 2.5 : 1.5}
          opacity={baseOpacity}
        />
        {item.label ? (
          <Text
            x={x}
            y={y - 16}
            text={item.label}
            fontSize={12}
            fill={color}
            stroke="#000000"
            strokeWidth={3}
            fillAfterStrokeEnabled
            fontStyle="bold"
            listening={false}
          />
        ) : null}
        {/* Resize handle — INSIDE the body subgroup so it translates WITH the
            rect during a body move (as a sibling it lagged once the live body
            override was removed). Its own drag resizes: the body group sits at
            offset 0,0 while resizing so the handle's node coords stay absolute,
            and onDragStart cancelBubble stops a body drag from also starting. */}
        {editable ? (
          <Circle
            x={x + w}
            y={y + h}
            radius={6}
            fill={color}
            stroke="#ffffff"
            strokeWidth={1.5}
            draggable
            dragBoundFunc={(pos) => ({
              x: Math.min(size.w, Math.max(x, pos.x)),
              y: Math.min(size.h, Math.max(y, pos.y)),
            })}
            onDragStart={(e) => {
              e.cancelBubble = true
            }}
            onDragMove={onHandleDragMove}
            onDragEnd={onHandleDragEnd}
            onMouseEnter={(e) => {
              const stage = e.target.getStage()
              if (stage) stage.container().style.cursor = 'nwse-resize'
            }}
            onMouseLeave={(e) => {
              const stage = e.target.getStage()
              if (stage) stage.container().style.cursor = 'default'
            }}
          />
        ) : null}
      </Group>
    </Group>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Grid item — cell-paint lattice (ported from MotionGridCanvas).
// ─────────────────────────────────────────────────────────────────────────────

interface GridItemProps {
  readonly item: MaskShapeItem
  readonly shape: Extract<MaskShape, { kind: 'grid' }>
  readonly color: string
  readonly dimmed: boolean
  readonly editable: boolean
  readonly size: { w: number; h: number }
  readonly onSelect: (id: string | number | null) => void
  readonly paintingRef: React.RefObject<boolean>
  readonly paintValueRef: React.RefObject<boolean>
  readonly paintedRef: React.RefObject<Set<number>>
  readonly paintCell: (
    itemId: string | number,
    shape: Extract<MaskShape, { kind: 'grid' }>,
    index: number,
    value: boolean,
  ) => void
}

function GridItem({
  item,
  shape,
  color,
  dimmed,
  editable,
  size,
  onSelect,
  paintingRef,
  paintValueRef,
  paintedRef,
  paintCell,
}: GridItemProps) {
  const { gridWidth, gridHeight, cells } = shape
  const cellW = size.w / gridWidth
  const cellH = size.h / gridHeight
  const total = gridWidth * gridHeight
  const opacity = dimmed ? 0.3 : 1

  const onCellDown = (index: number): void => {
    if (!editable) {
      onSelect(item.id)
      return
    }
    const nextValue = cells[index] !== true
    paintingRef.current = true
    paintValueRef.current = nextValue
    paintedRef.current = new Set([index])
    paintCell(item.id, shape, index, nextValue)
  }

  const onCellEnter = (index: number): void => {
    if (!paintingRef.current || !editable) return
    if (paintedRef.current.has(index)) return
    paintedRef.current.add(index)
    paintCell(item.id, shape, index, paintValueRef.current)
  }

  const endPaint = (): void => {
    if (!paintingRef.current) return
    paintingRef.current = false
    paintedRef.current = new Set()
  }

  return (
    <Group opacity={opacity} onMouseUp={endPaint} onMouseLeave={endPaint}>
      {Array.from({ length: total }, (_, i) => {
        const col = i % gridWidth
        const row = Math.floor(i / gridWidth)
        const active = cells[i] === true
        return (
          <Rect
            key={i}
            x={col * cellW}
            y={row * cellH}
            width={cellW}
            height={cellH}
            fill={active ? color + FILL_ALPHA_SELECTED : '#ffffff10'}
            stroke={active ? color : '#ffffff40'}
            strokeWidth={0.5}
            onMouseDown={(e) => {
              e.cancelBubble = true
              onCellDown(i)
            }}
            onMouseEnter={() => onCellEnter(i)}
          />
        )
      })}
    </Group>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Point item — polygon + line/tripwire. Vertex-drag + body-drag + add/remove,
// with optimistic override. Generalized from ZoneCanvas's zone rendering.
// ─────────────────────────────────────────────────────────────────────────────

interface PointItemProps {
  readonly item: MaskShapeItem
  readonly shape: PointShape
  readonly color: string
  readonly selected: boolean
  readonly dimmed: boolean
  readonly editable: boolean
  readonly isLine: boolean
  readonly isDrawing: boolean
  readonly size: { w: number; h: number }
  readonly effectivePoints: readonly MaskPoint[]
  readonly minVertices: number
  readonly maxVertices: number | undefined
  readonly isDragging: boolean
  readonly onSelect: (id: string | number | null) => void
  readonly onShapeChange: (id: string | number, shape: MaskShape) => void
  readonly setDragOverride: React.Dispatch<React.SetStateAction<DragOverride | null>>
  readonly setDraggingItemId: React.Dispatch<React.SetStateAction<string | number | null>>
}

function PointItem({
  item,
  shape,
  color,
  selected,
  dimmed,
  editable,
  isLine,
  isDrawing,
  size,
  effectivePoints,
  minVertices,
  maxVertices,
  isDragging,
  onSelect,
  onShapeChange,
  setDragOverride,
  setDraggingItemId,
}: PointItemProps) {
  const pts = flatPoints(effectivePoints, size.w, size.h)
  const baseOpacity = dimmed ? 0.35 : selected ? 1 : isLine ? 0.8 : 0.85

  // Commit a new point set as a same-kind shape (immutable, no `kind` widening).
  const commitPoints = (points: readonly MaskPoint[]): MaskShape =>
    isLine ? { kind: 'line', points: [...points] } : { kind: 'polygon', points: [...points] }

  // Body-drag clamp — keep the bbox inside the stage.
  const xs = effectivePoints.map((p) => p.x * size.w)
  const ys = effectivePoints.map((p) => p.y * size.h)
  const minX = xs.length > 0 ? Math.min(...xs) : 0
  const maxX = xs.length > 0 ? Math.max(...xs) : 0
  const minY = ys.length > 0 ? Math.min(...ys) : 0
  const maxY = ys.length > 0 ? Math.max(...ys) : 0
  const dragBoundFunc = (pos: { x: number; y: number }): { x: number; y: number } => ({
    x: Math.max(-minX, Math.min(size.w - maxX, pos.x)),
    y: Math.max(-minY, Math.min(size.h - maxY, pos.y)),
  })

  const onBodyDragEnd = (e: Konva.KonvaEventObject<DragEvent>): void => {
    const node = e.target
    const dx = node.x() / size.w
    const dy = node.y() / size.h
    node.position({ x: 0, y: 0 })
    setDraggingItemId(null)
    if (dx === 0 && dy === 0) return
    const updated = shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
    setDragOverride({ itemId: item.id, points: updated })
    onShapeChange(item.id, commitPoints(updated))
  }

  const canRemoveVertex = !isLine && effectivePoints.length > minVertices
  const canAddVertex =
    !isLine && (maxVertices === undefined || effectivePoints.length < maxVertices)

  return (
    <Group
      onClick={(e) => {
        e.cancelBubble = true
        if (!isDrawing) onSelect(item.id)
      }}
    >
      {/* Body subgroup — line/polygon + label translate together on a body drag. */}
      <Group
        draggable={editable}
        dragBoundFunc={editable ? dragBoundFunc : undefined}
        onDragStart={editable ? () => setDraggingItemId(item.id) : undefined}
        onDragEnd={editable ? onBodyDragEnd : undefined}
        onMouseEnter={(e) => {
          if (!editable) return
          const stage = e.target.getStage()
          if (stage) stage.container().style.cursor = 'move'
        }}
        onMouseLeave={(e) => {
          if (!editable) return
          const stage = e.target.getStage()
          if (stage) stage.container().style.cursor = isDrawing ? 'crosshair' : 'default'
        }}
      >
        {isLine ? (
          <Arrow
            points={pts}
            stroke={color}
            strokeWidth={selected ? 3 : 2}
            fill={color}
            pointerLength={10}
            pointerWidth={8}
            opacity={baseOpacity}
          />
        ) : (
          <Line
            points={pts}
            closed
            fill={color + (selected ? FILL_ALPHA_SELECTED : FILL_ALPHA)}
            stroke={color}
            strokeWidth={selected ? 2.5 : 1.5}
            opacity={baseOpacity}
          />
        )}

        {item.label && effectivePoints.length > 0
          ? (() => {
              const cx = effectivePoints.reduce((s, p) => s + p.x, 0) / effectivePoints.length
              const cy = effectivePoints.reduce((s, p) => s + p.y, 0) / effectivePoints.length
              const c = toCanvas({ x: cx, y: cy }, size.w, size.h)
              const approxWidth = Math.max(40, item.label.length * 11 * 0.62)
              return (
                <Text
                  x={c.x - approxWidth / 2}
                  y={c.y - 7}
                  width={approxWidth}
                  align="center"
                  text={item.label}
                  fontSize={12}
                  fill={color}
                  stroke="#000000"
                  strokeWidth={3}
                  fillAfterStrokeEnabled
                  fontStyle="bold"
                  listening={false}
                />
              )
            })()
          : null}
      </Group>

      {/* Vertex handles — drag to move, right-click to remove (gated). */}
      {editable &&
        !isDragging &&
        effectivePoints.map((p, idx) => {
          const cp = toCanvas(p, size.w, size.h)
          return (
            <Circle
              key={`pt-${idx}`}
              x={cp.x}
              y={cp.y}
              radius={5}
              fill={color}
              stroke="#ffffff"
              strokeWidth={1.5}
              draggable
              onDragMove={(e) => {
                const newPt = toNorm({ x: e.target.x(), y: e.target.y() }, size.w, size.h)
                setDragOverride((prev) => {
                  const base = prev && prev.itemId === item.id ? prev.points : shape.points
                  return { itemId: item.id, points: base.map((pp, i) => (i === idx ? newPt : pp)) }
                })
              }}
              onDragEnd={(e) => {
                const newPt = toNorm({ x: e.target.x(), y: e.target.y() }, size.w, size.h)
                const updated = shape.points.map((pp, i) => (i === idx ? newPt : pp))
                setDragOverride({ itemId: item.id, points: updated })
                onShapeChange(item.id, commitPoints(updated))
              }}
              onContextMenu={(e) => {
                e.evt.preventDefault()
                e.cancelBubble = true
                if (!canRemoveVertex) return
                onShapeChange(item.id, commitPoints(shape.points.filter((_, i) => i !== idx)))
              }}
            />
          )
        })}

      {/* Midpoint "+" handles — polygons only, click to insert a vertex. */}
      {editable &&
        !isDragging &&
        canAddVertex &&
        effectivePoints.length >= 2 &&
        effectivePoints.map((p, idx) => {
          const next = effectivePoints[(idx + 1) % effectivePoints.length]!
          const cp = toCanvas({ x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 }, size.w, size.h)
          return (
            <Circle
              key={`mid-${idx}`}
              x={cp.x}
              y={cp.y}
              radius={4}
              fill="#ffffff"
              stroke={color}
              strokeWidth={1.5}
              opacity={0.6}
              onMouseEnter={(e) => {
                const node = e.target as Konva.Circle
                node.to({ radius: 6, opacity: 1, duration: 0.1 })
                const stage = node.getStage()
                if (stage) stage.container().style.cursor = 'copy'
              }}
              onMouseLeave={(e) => {
                const node = e.target as Konva.Circle
                node.to({ radius: 4, opacity: 0.6, duration: 0.1 })
                const stage = node.getStage()
                if (stage) stage.container().style.cursor = isDrawing ? 'crosshair' : 'default'
              }}
              onClick={(e) => {
                e.cancelBubble = true
                onShapeChange(item.id, commitPoints(insertMidpoint(shape.points, idx)))
              }}
            />
          )
        })}
    </Group>
  )
}

/**
 * Memoised export. The Konva scene is expensive to re-evaluate (many nodes per
 * item + per-item drag-bound closures) and overlay parents re-render on every
 * detection/motion event. Mirrors ZoneCanvas's `memo`.
 */
export const MaskShapeCanvas: MemoExoticComponent<typeof MaskShapeCanvasImpl> =
  memo(MaskShapeCanvasImpl)
