import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { CHART_SERIES_TOKENS, type ChartSeriesToken } from '../../charts/chart-palette'
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
  /** False for a day total (kWh): a solid line and an arrow, no running dots. Default true. */
  readonly animate?: boolean
}

/** One figure of the centre circle: its short name and its value ("—" when unknown). */
export interface EnergyCentreFigure {
  readonly id: string
  readonly label: string
  readonly value: string
  /** Small unit written after the value ("kWh"). */
  readonly unit?: string
}

export interface EnergyFlowIllustrationProps {
  readonly nodes: readonly EnergyNodeView[]
  /** The day's figures drawn inside the enlarged bus circle; omit for the small bus dot. */
  readonly centre?: readonly EnergyCentreFigure[]
  readonly ariaLabel: string
  readonly className?: string
}

/**
 * The chart slot each node owns: the scene tints a node with it and the day
 * chart draws that node's line with the same slot, so one colour means one
 * node in both.
 */
export const ENERGY_NODE_SLOT: Readonly<Record<EnergyNodeId, number>> = {
  solar: 4,
  grid: 0,
  battery: 6,
  house: 5,
  heatPump: 2,
}

/** Spelled out so Tailwind finds every class. */
const SLOT_TEXT: Readonly<Record<ChartSeriesToken, string>> = {
  'chart-series-a': 'text-chart-series-a',
  'chart-series-b': 'text-chart-series-b',
  'chart-series-c': 'text-chart-series-c',
  'chart-series-d': 'text-chart-series-d',
  'chart-series-e': 'text-chart-series-e',
  'chart-series-f': 'text-chart-series-f',
  'chart-series-g': 'text-chart-series-g',
  'chart-series-h': 'text-chart-series-h',
}

function toneOf(id: EnergyNodeId): string {
  const token = CHART_SERIES_TOKENS[ENERGY_NODE_SLOT[id]] ?? 'chart-series-a'
  return SLOT_TEXT[token]
}

const BUS = { x: 130, y: 92 } as const
const R = 19
/** The bus dot, and the circle that holds the day's figures. */
const BUS_R = 6
const CENTRE_R = 48
const ICON = 18
/** Half-width and spacing of the centre figures' rows. */
const ROW_DX = 38
const ROW_DY = 14

interface NodePlace {
  readonly x: number
  readonly y: number
  readonly lx: number
  readonly ly: number
  readonly anchor: 'start' | 'middle' | 'end'
  readonly glyph: CardGlyph
}

const PLACE: Readonly<Record<EnergyNodeId, NodePlace>> = {
  solar: { x: 130, y: -6, lx: 154, ly: -12, anchor: 'start', glyph: 'solar' },
  grid: { x: 28, y: 92, lx: 28, ly: 124, anchor: 'middle', glyph: 'grid' },
  battery: {
    x: 232,
    y: 92,
    lx: 256,
    ly: 124,
    anchor: 'end',
    glyph: 'battery',
  },
  house: {
    x: 76,
    y: 160,
    lx: 76,
    ly: 192,
    anchor: 'middle',
    glyph: 'home',
  },
  heatPump: {
    x: 184,
    y: 160,
    lx: 184,
    ly: 192,
    anchor: 'middle',
    glyph: 'heatPump',
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
  const mx = (x0 + ux * start + x1 - ux * end) / 2
  const my = (y0 + uy * start + y1 - uy * end) / 2
  return { d, mx, my, angle: (Math.atan2(uy, ux) * 180) / Math.PI }
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
      className={toneOf(node.id)}
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
            strokeLinecap="round"
            data-live={node.animate === false ? undefined : 'true'}
            className={node.animate === false ? undefined : 'dc-energy-flow'}
          />
          <path
            d="M-5 -5L4 0L-5 5Z"
            data-testid={`dc-energy-arrow-${node.id}`}
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
    <g className={toneOf(node.id)} data-testid={`dc-energy-node-${node.id}`}>
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
 * The day's four figures inside the bus circle as a list of rows: the name on
 * the left, the value on the right with its unit small after it.
 */
function CentreFigures({
  figures,
}: {
  readonly figures: readonly EnergyCentreFigure[]
}): ReactElement {
  const rows = figures.slice(0, 4)
  return (
    <g
      role="group"
      aria-label={rows.map((f) => `${f.label}: ${f.value}${f.unit ?? ''}`).join(', ')}
      data-testid="dc-energy-centre"
    >
      {rows.map((f, i) => {
        const y = BUS.y + (i - (rows.length - 1) / 2) * ROW_DY + 3
        return (
          <g key={f.id} data-testid={`dc-energy-centre-${f.id}`}>
            <text x={BUS.x - ROW_DX} y={y} className="fill-foreground-muted text-[6px]">
              {f.label}
            </text>
            <text
              x={BUS.x + ROW_DX}
              y={y}
              textAnchor="end"
              className="fill-foreground text-[10px] font-semibold tabular-nums"
            >
              {f.value}
              {f.unit === undefined ? null : (
                <tspan dx={1.5} className="fill-foreground-muted text-[6.5px] font-normal">
                  {f.unit}
                </tspan>
              )}
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
      viewBox="0 -32 260 238"
      role="img"
      aria-label={ariaLabel}
      data-still={still}
      className={cn('dc-energy overflow-visible', className)}
    >
      <g data-testid="dc-energy-branches">
        {nodes.map((n) => (
          <Branch key={`b-${n.id}`} node={n} busR={busR} />
        ))}
      </g>
      <circle
        cx={BUS.x}
        cy={BUS.y}
        r={busR}
        strokeWidth={2.5}
        className="fill-surface stroke-foreground-muted"
      />
      {centre === undefined ? null : <CentreFigures figures={centre} />}
      <g data-testid="dc-energy-nodes">
        {nodes.map((n) => (
          <Node key={`n-${n.id}`} node={n} />
        ))}
      </g>
    </svg>
  )
}
