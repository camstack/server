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

/** One figure of the centre circle: its short name and its value ("—" when unknown). */
export interface EnergyCentreFigure {
  readonly id: string
  readonly label: string
  readonly value: string
}

export interface EnergyFlowIllustrationProps {
  readonly nodes: readonly EnergyNodeView[]
  /** The day's figures drawn inside the enlarged bus circle; omit for the small bus dot. */
  readonly centre?: readonly EnergyCentreFigure[]
  readonly ariaLabel: string
  readonly className?: string
}

const BUS = { x: 130, y: 92 } as const
const R = 19
/** The bus dot, and the circle that holds the day's figures. */
const BUS_R = 6
const CENTRE_R = 46
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
  solar: { x: 130, y: 6, lx: 154, ly: 0, anchor: 'start', glyph: 'solar', tone: 'text-primary' },
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
    x: 66,
    y: 176,
    lx: 66,
    ly: 208,
    anchor: 'middle',
    glyph: 'home',
    tone: 'text-foreground',
  },
  heatPump: {
    x: 194,
    y: 176,
    lx: 194,
    ly: 208,
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
function segment(place: NodePlace, inward: boolean, busR: number): Segment {
  const [x0, y0, x1, y1] = inward
    ? [place.x, place.y, BUS.x, BUS.y]
    : [BUS.x, BUS.y, place.x, place.y]
  const length = Math.hypot(x1 - x0, y1 - y0)
  const ux = (x1 - x0) / length
  const uy = (y1 - y0) / length
  const start = inward ? R : busR
  const end = inward ? busR : R
  const d = `M${(x0 + ux * start).toFixed(1)} ${(y0 + uy * start).toFixed(1)}L${(x1 - ux * end).toFixed(1)} ${(y1 - uy * end).toFixed(1)}`
  return { d, mx: (x0 + x1) / 2, my: (y0 + y1) / 2, angle: (Math.atan2(uy, ux) * 180) / Math.PI }
}

function Branch({
  node,
  busR,
}: {
  readonly node: EnergyNodeView
  readonly busR: number
}): ReactElement {
  const place = PLACE[node.id]
  const seg = segment(place, node.watts > 0, busR)
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

const FIGURE_STEP = 22

/** The figures stacked in the bus circle, centred: a small name over a bold value. */
function CentreFigures({
  figures,
}: {
  readonly figures: readonly EnergyCentreFigure[]
}): ReactElement {
  const top = BUS.y - ((figures.length - 1) * FIGURE_STEP) / 2
  return (
    <g data-testid="dc-energy-centre" textAnchor="middle">
      {figures.map((f, i) => {
        const y = top + i * FIGURE_STEP
        return (
          <g key={f.id} data-testid={`dc-energy-centre-${f.id}`}>
            <text x={BUS.x} y={y - 4} className="fill-foreground-muted text-[7.5px]">
              {f.label}
            </text>
            <text
              x={BUS.x}
              y={y + 9}
              className="fill-foreground text-[13px] font-semibold tabular-nums"
            >
              {f.value}
            </text>
          </g>
        )
      })}
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
  centre,
  ariaLabel,
  className,
}: EnergyFlowIllustrationProps): ReactElement {
  const busR = centre === undefined ? BUS_R : CENTRE_R
  const still = nodes.every((n) => n.still)
  return (
    <svg
      viewBox="0 -16 260 242"
      role="img"
      aria-label={ariaLabel}
      data-still={still}
      className={cn('dc-energy overflow-visible', className)}
    >
      {nodes.map((n) => (
        <Branch key={`b-${n.id}`} node={n} busR={busR} />
      ))}
      <circle
        cx={BUS.x}
        cy={BUS.y}
        r={busR}
        strokeWidth={2.5}
        className="fill-surface stroke-foreground-muted"
      />
      {centre === undefined ? null : <CentreFigures figures={centre} />}
      {nodes.map((n) => (
        <Node key={`n-${n.id}`} node={n} />
      ))}
    </svg>
  )
}
