import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { CARD_ICONS, type CardGlyph } from '../icons'
import { speedBand } from './AmbientFx'

export type EnergyNodeId = 'solar' | 'grid' | 'battery' | 'house' | 'heatPump'

export interface EnergyNodeView {
  readonly id: EnergyNodeId
  /** Signed against the bus: + into it, − out of it. */
  readonly watts: number
  /** "Solar", "Import", "Charging · 78%". */
  readonly label: string
  /** "4.2 kW". */
  readonly value: string
  /** True when the node draws nothing (no dots, no arrow, a dotted line). */
  readonly still: boolean
}

export interface EnergyFlowIllustrationProps {
  readonly nodes: readonly EnergyNodeView[]
  readonly ariaLabel: string
  readonly className?: string
}

const BUS = { x: 130, y: 92 } as const
const R = 19
const ICON = 18

interface NodePlace {
  readonly x: number
  readonly y: number
  readonly lx: number
  readonly ly: number
  readonly anchor: 'start' | 'middle'
  readonly glyph: CardGlyph
  readonly tone: string
}

const PLACE: Readonly<Record<EnergyNodeId, NodePlace>> = {
  solar: { x: 130, y: 22, lx: 154, ly: 16, anchor: 'start', glyph: 'solar', tone: 'text-primary' },
  grid: { x: 28, y: 92, lx: 28, ly: 124, anchor: 'middle', glyph: 'grid', tone: 'text-info' },
  battery: {
    x: 232,
    y: 92,
    lx: 232,
    ly: 124,
    anchor: 'middle',
    glyph: 'battery',
    tone: 'text-success',
  },
  house: {
    x: 76,
    y: 160,
    lx: 76,
    ly: 192,
    anchor: 'middle',
    glyph: 'home',
    tone: 'text-foreground',
  },
  heatPump: {
    x: 184,
    y: 160,
    lx: 184,
    ly: 192,
    anchor: 'middle',
    glyph: 'heatPump',
    tone: 'text-warning',
  },
}

/** kW → the shared 0..100 speed scale: 5 kW and above runs at full speed. */
const FULL_SCALE_W = 5000

interface Segment {
  readonly d: string
  readonly mx: number
  readonly my: number
  readonly angle: number
}

/** The branch from the node to the bus (inward) or from the bus to the node. */
function segment(place: NodePlace, inward: boolean): Segment {
  const [x0, y0, x1, y1] = inward
    ? [place.x, place.y, BUS.x, BUS.y]
    : [BUS.x, BUS.y, place.x, place.y]
  const length = Math.hypot(x1 - x0, y1 - y0)
  const ux = (x1 - x0) / length
  const uy = (y1 - y0) / length
  const start = inward ? R : 6
  const end = inward ? 6 : R
  const d = `M${(x0 + ux * start).toFixed(1)} ${(y0 + uy * start).toFixed(1)}L${(x1 - ux * end).toFixed(1)} ${(y1 - uy * end).toFixed(1)}`
  return { d, mx: (x0 + x1) / 2, my: (y0 + y1) / 2, angle: (Math.atan2(uy, ux) * 180) / Math.PI }
}

function Branch({ node }: { readonly node: EnergyNodeView }): ReactElement {
  const place = PLACE[node.id]
  const seg = segment(place, node.watts > 0)
  const pct = Math.min(100, (Math.abs(node.watts) / FULL_SCALE_W) * 100)
  return (
    <g
      className={place.tone}
      data-testid={`dc-energy-branch-${node.id}`}
      data-speed={node.still ? undefined : speedBand(pct)}
      data-direction={node.still ? 'still' : node.watts > 0 ? 'in' : 'out'}
    >
      <path
        d={seg.d}
        fill="none"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={node.still ? '2 5' : undefined}
        className="stroke-border"
      />
      {node.still ? null : (
        <>
          <path
            d={seg.d}
            fill="none"
            strokeWidth={3}
            stroke="currentColor"
            data-live="true"
            className="dc-energy-flow"
          />
          <path
            d="M-5 -5L4 0L-5 5Z"
            fill="currentColor"
            transform={`translate(${seg.mx.toFixed(1)} ${seg.my.toFixed(1)}) rotate(${seg.angle.toFixed(1)})`}
          />
        </>
      )}
    </g>
  )
}

function Node({ node }: { readonly node: EnergyNodeView }): ReactElement {
  const place = PLACE[node.id]
  const Icon = CARD_ICONS[place.glyph]
  return (
    <g className={place.tone} data-testid={`dc-energy-node-${node.id}`}>
      <circle
        cx={place.x}
        cy={place.y}
        r={R}
        strokeWidth={2.5}
        stroke="currentColor"
        className="fill-surface"
      />
      <Icon x={place.x - ICON / 2} y={place.y - ICON / 2} width={ICON} height={ICON} aria-hidden />
      <text
        x={place.lx}
        y={place.ly}
        textAnchor={place.anchor}
        className="fill-foreground-muted text-[11px]"
      >
        {node.label}
      </text>
      <text
        x={place.lx}
        y={place.ly + 14}
        textAnchor={place.anchor}
        className="fill-foreground text-[13px] font-semibold tabular-nums"
      >
        {node.value}
      </text>
    </g>
  )
}

/**
 * The energy system as a bus: solar on top, the grid and the battery on the
 * sides, the house and the heat pump below. Each branch runs dots INTO the
 * bus or OUT of it at the speed of its power, with one arrowhead mid-branch;
 * a node below the still threshold draws a dotted line and nothing moves.
 */
export function EnergyFlowIllustration({
  nodes,
  ariaLabel,
  className,
}: EnergyFlowIllustrationProps): ReactElement {
  const still = nodes.every((n) => n.still)
  return (
    <svg
      viewBox="0 0 260 206"
      role="img"
      aria-label={ariaLabel}
      data-still={still}
      className={cn('dc-energy overflow-visible', className)}
    >
      {nodes.map((n) => (
        <Branch key={`b-${n.id}`} node={n} />
      ))}
      <circle
        cx={BUS.x}
        cy={BUS.y}
        r={6}
        strokeWidth={2.5}
        className="fill-surface stroke-foreground-muted"
      />
      {nodes.map((n) => (
        <Node key={`n-${n.id}`} node={n} />
      ))}
    </svg>
  )
}
