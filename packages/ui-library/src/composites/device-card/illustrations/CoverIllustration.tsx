import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useRef,
} from 'react'
import { cn } from '../../../lib/cn'

/** The eight drawings a cover role picks from. */
export type CoverDrawing =
  | 'shutter'
  | 'blind'
  | 'curtain'
  | 'awning'
  | 'window'
  | 'garage'
  | 'gate'
  | 'door'

/** Which way the drawing's grip is dragged; none has no grip. */
export type CoverDrag = 'y' | 'x' | 'none'

export interface CoverIllustrationProps {
  readonly drawing: CoverDrawing
  /**
   * How far the drawing is drawn, 0..100, in the DRAWING's sense: covered for a
   * shutter / blind / curtain / garage / gate / door, extended for an awning,
   * open for a window.
   */
  readonly value: number
  readonly drag: CoverDrag
  readonly ariaLabel: string
  /** The grip's accessible name ("Drag"). */
  readonly gripLabel?: string
  /** False while the card is gated: the grip is drawn but does not move. */
  readonly interactive?: boolean
  /** Every move of the grip. */
  readonly onDrag?: (value: number) => void
  /** Once, where the grip was let go. */
  readonly onDragEnd?: (value: number) => void
  readonly className?: string
}

const W = 120
const H = 176
const KEY_STEP = 5
const clamp = (v: number): number => Math.max(0, Math.min(100, Math.round(v)))

const FRAME = (
  <>
    <rect
      x={4}
      y={4}
      width={112}
      height={162}
      rx={6}
      fill="none"
      strokeWidth={3}
      className="stroke-foreground-muted"
    />
    <rect x={10} y={10} width={100} height={150} className="fill-primary/10" />
  </>
)

function Grip({
  x,
  y,
  horizontal,
  label,
  value,
}: {
  readonly x: number
  readonly y: number
  readonly horizontal: boolean
  readonly label: string
  readonly value: number
}): ReactElement {
  return (
    <g
      className="dc-grip"
      data-grip
      tabIndex={0}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      {horizontal ? (
        <>
          <rect x={x - 12} y={y - 30} width={24} height={60} fill="transparent" />
          <rect
            className="dc-pill fill-primary"
            x={x - 4}
            y={y - 20}
            width={8}
            height={40}
            rx={4}
          />
        </>
      ) : (
        <>
          <rect x={10} y={y - 11} width={100} height={22} fill="transparent" />
          <rect className="dc-pill fill-primary" x={40} y={y - 4} width={40} height={8} rx={4} />
        </>
      )}
    </g>
  )
}

interface Drawn {
  readonly body: ReactNode
  /** Where the grip sits, when the drawing has one. */
  readonly grip: { readonly x: number; readonly y: number; readonly horizontal: boolean } | null
}

const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = []
  for (let n = from; step > 0 ? n < to : n > to; n += step) out.push(n)
  return out
}

function shutter(v: number): Drawn {
  const e = 10 + (150 * v) / 100
  return {
    body: (
      <>
        {FRAME}
        <g strokeWidth={1} className="fill-border stroke-foreground-muted">
          {range(10, e, 10).map((y) => (
            <rect key={y} x={10} y={y} width={100} height={Math.min(10, e - y)} />
          ))}
        </g>
      </>
    ),
    grip: { x: 60, y: e, horizontal: false },
  }
}

function blind(v: number): Drawn {
  const e = 10 + (150 * v) / 100
  return {
    body: (
      <>
        {FRAME}
        <rect x={10} y={10} width={100} height={e - 10} opacity={0.9} className="fill-border" />
        <rect x={8} y={e - 3} width={104} height={6} rx={2} className="fill-foreground-muted" />
      </>
    ),
    grip: { x: 60, y: e, horizontal: false },
  }
}

function curtain(v: number): Drawn {
  const w = (50 * v) / 100
  return {
    body: (
      <>
        {FRAME}
        <line x1={2} y1={8} x2={118} y2={8} strokeWidth={3} className="stroke-foreground-muted" />
        <g className="fill-border">
          <rect x={10} y={10} width={w} height={150} />
          <rect x={110 - w} y={10} width={w} height={150} />
        </g>
        <g strokeWidth={1} opacity={0.5} className="stroke-foreground-muted">
          {range(14, 10 + w, 8).map((x) => (
            <line key={`l${x}`} x1={x} y1={12} x2={x} y2={160} />
          ))}
          {range(106, 110 - w, -8).map((x) => (
            <line key={`r${x}`} x1={x} y1={12} x2={x} y2={160} />
          ))}
        </g>
      </>
    ),
    grip: { x: 10 + w, y: 85, horizontal: true },
  }
}

function awning(v: number): Drawn {
  const l = 10 + (90 * v) / 100
  const x = 20 + l * 0.95
  const y = 46 + l * 0.32
  return {
    body: (
      <>
        <rect
          x={8}
          y={10}
          width={12}
          height={156}
          className="fill-border stroke-foreground-muted"
        />
        <rect
          x={20}
          y={96}
          width={70}
          height={70}
          className="fill-primary/10 stroke-foreground-muted"
        />
        <line
          x1={20}
          y1={46}
          x2={x}
          y2={y}
          strokeWidth={7}
          strokeLinecap="round"
          className="stroke-primary"
        />
        <line x1={x} y1={y} x2={x} y2={y + 12} strokeWidth={3} className="stroke-primary" />
      </>
    ),
    grip: { x, y, horizontal: true },
  }
}

function windowPane(v: number): Drawn {
  const d = (60 * v) / 100
  return {
    body: (
      <>
        {FRAME}
        <polygon
          points={`10,10 110,10 ${110 + d * 0.25},${160 - d * 0.4} ${10 - d * 0.25},${160 - d * 0.4}`}
          strokeWidth={2}
          opacity={0.95}
          className="fill-background-elevated stroke-foreground-muted"
        />
        <line
          x1={60}
          y1={150 - d * 0.4}
          x2={60}
          y2={156 - d * 0.4}
          strokeWidth={3}
          className="stroke-foreground-muted"
        />
      </>
    ),
    grip: null,
  }
}

function garage(v: number): Drawn {
  const e = 30 + (136 * v) / 100
  return {
    body: (
      <>
        <path
          d="M2 30 L60 4 L118 30"
          fill="none"
          strokeWidth={3}
          className="stroke-foreground-muted"
        />
        <rect
          x={8}
          y={26}
          width={104}
          height={144}
          strokeWidth={3}
          className="fill-primary/10 stroke-foreground-muted"
        />
        <g className="fill-border stroke-foreground-muted">
          {range(30, e, 17).map((y) => (
            <rect key={y} x={12} y={y} width={96} height={Math.min(17, e - y)} />
          ))}
        </g>
      </>
    ),
    grip: null,
  }
}

function gate(v: number): Drawn {
  const w = (48 * v) / 100 + 4
  const bars = (x0: number): ReactNode =>
    [1, 2, 3, 4, 5].map((i) => (
      <line key={`${x0}-${i}`} x1={x0 + (w * i) / 6} y1={62} x2={x0 + (w * i) / 6} y2={150} />
    ))
  return {
    body: (
      <>
        <rect x={2} y={50} width={8} height={116} className="fill-foreground-muted" />
        <rect x={110} y={50} width={8} height={116} className="fill-foreground-muted" />
        <g fill="none" strokeWidth={3} className="stroke-foreground-muted">
          <rect x={10} y={60} width={w} height={92} />
          <rect x={110 - w} y={60} width={w} height={92} />
        </g>
        <g strokeWidth={2} className="stroke-foreground-muted">
          {bars(10)}
          {bars(110 - w)}
        </g>
      </>
    ),
    grip: null,
  }
}

function door(v: number): Drawn {
  const w = 6 + (64 * v) / 100
  return {
    body: (
      <>
        <rect
          x={22}
          y={8}
          width={76}
          height={160}
          strokeWidth={3}
          className="fill-primary/10 stroke-foreground-muted"
        />
        <polygon
          points={`25,11 ${25 + w},${11 + (70 - w) * 0.15} ${25 + w},${165 - (70 - w) * 0.15} 25,165`}
          strokeWidth={2}
          className="fill-border stroke-foreground-muted"
        />
        <circle cx={25 + w - 8} cy={90} r={3} className="fill-foreground-muted" />
      </>
    ),
    grip: null,
  }
}

const DRAW: Readonly<Record<CoverDrawing, (v: number) => Drawn>> = {
  shutter,
  blind,
  curtain,
  awning,
  window: windowPane,
  garage,
  gate,
  door,
}

/** The drawing's value under a pointer, in viewBox units. */
function valueAt(drawing: CoverDrawing, drag: CoverDrag, px: number, py: number): number {
  if (drag === 'y') return ((py - 10) / 150) * 100
  if (drawing === 'curtain') return ((px - 10) / 50) * 100
  return (px - 20) / 0.95 - 10
}

/**
 * A cover drawn as what it is (a shutter, an awning, a gate …) at its current
 * position. The drawings that have a grip can be dragged, or moved with the
 * arrow keys once the grip has focus.
 */
export function CoverIllustration({
  drawing,
  value,
  drag,
  ariaLabel,
  gripLabel = 'Drag',
  interactive = true,
  onDrag,
  onDragEnd,
  className,
}: CoverIllustrationProps): ReactElement {
  const dragging = useRef<number | null>(null)
  const drawn = DRAW[drawing](clamp(value))
  const canDrag = drag !== 'none' && interactive && drawn.grip !== null

  const pointValue = (e: PointerEvent<SVGSVGElement>): number => {
    const box = e.currentTarget.getBoundingClientRect()
    const px = box.width === 0 ? 0 : ((e.clientX - box.left) * W) / box.width
    const py = box.height === 0 ? 0 : ((e.clientY - box.top) * H) / box.height
    return clamp(valueAt(drawing, drag, px, py))
  }
  const onPointerDown = (e: PointerEvent<SVGSVGElement>): void => {
    if (!canDrag || !(e.target instanceof Element) || e.target.closest('[data-grip]') === null)
      return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragging.current = clamp(value)
  }
  const onPointerMove = (e: PointerEvent<SVGSVGElement>): void => {
    if (dragging.current === null) return
    const next = pointValue(e)
    dragging.current = next
    onDrag?.(next)
  }
  const onPointerUp = (): void => {
    if (dragging.current === null) return
    const last = dragging.current
    dragging.current = null
    onDragEnd?.(last)
  }
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>): void => {
    if (!canDrag || !(e.target instanceof Element) || e.target.closest('[data-grip]') === null)
      return
    const step =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? KEY_STEP
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -KEY_STEP
          : 0
    if (step === 0) return
    e.preventDefault()
    const next = clamp(value + step)
    onDrag?.(next)
    onDragEnd?.(next)
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={ariaLabel}
      data-drawing={drawing}
      className={cn('dc-cover text-primary', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      {drawn.body}
      {canDrag && drawn.grip !== null ? (
        <Grip
          x={drawn.grip.x}
          y={drawn.grip.y}
          horizontal={drawn.grip.horizontal}
          label={gripLabel}
          value={clamp(value)}
        />
      ) : null}
    </svg>
  )
}

/** Three slats at an angle, for the tilt buttons. */
export function SlatGlyph({ angle }: { readonly angle: number }): ReactElement {
  const rad = (angle * Math.PI) / 180
  const dx = 5 * Math.cos(rad)
  const dy = 5 * Math.sin(rad)
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden>
      <g stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        {[4, 9, 14].map((y) => (
          <line key={y} x1={9 - dx} y1={y - dy} x2={9 + dx} y2={y + dy} />
        ))}
      </g>
    </svg>
  )
}
