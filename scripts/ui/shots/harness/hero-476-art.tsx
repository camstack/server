/** The drawings of the planning#476 mockups: the heat pump unit and the energy flow. */
import { Flame, House, Sun, Zap, type LucideIcon } from 'lucide-react'
import { type ReactNode } from 'react'

export const BODY = 'fill-background-elevated stroke-border'

/** Italian number: decimal comma, fixed digits. */
export const n = (v: number, digits = 1): string => v.toFixed(digits).replace('.', ',')

// ---------------------------------------------------------------- heat pump art

/**
 * The outdoor unit: housing, a grille with the fan (spins while the compressor runs, like
 * the pump of the fountain), warm air rising off the top (`art-heat`), and the water
 * circuit leaving the side (`art-stream`, warm supply over a cool return).
 */
export function HeatPumpArt({ running }: { readonly running: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 200 170" aria-hidden="true" className="h-36 w-auto max-w-full">
      <rect x="28" y="26" width="112" height="128" rx="14" className={BODY} strokeWidth="2" />
      <circle cx="46" cy="42" r="3.5" className="fill-current" />
      <rect x="56" y="38" width="40" height="8" rx="4" className="fill-surface-hover" />
      <circle cx="84" cy="98" r="44" className="fill-surface stroke-border" strokeWidth="3" />
      <circle cx="84" cy="98" r="36" className="fill-none stroke-border" strokeWidth="1.5" />
      <g className={running ? 'art-spin-fast' : undefined}>
        <path
          d="M84 98 q-8 -18 0 -32 q10 12 0 32z M84 98 q18 -8 32 0 q-12 10 -32 0z M84 98 q8 18 0 32 q-10 -12 0 -32z M84 98 q-18 8 -32 0 q12 -10 32 0z"
          className="fill-current opacity-80"
        />
        <circle cx="84" cy="98" r="5" className="fill-background stroke-border" strokeWidth="2" />
      </g>
      {running ? (
        <g className="stroke-current" fill="none" strokeWidth="2" strokeLinecap="round">
          <path className="art-heat" d="M52 22 q4 -6 0 -12 q-4 -6 0 -12" />
          <path className="art-heat" d="M84 22 q4 -6 0 -12 q-4 -6 0 -12" />
          <path className="art-heat" d="M116 22 q4 -6 0 -12 q-4 -6 0 -12" />
        </g>
      ) : null}
      <path d="M140 70 H176 V150" className="fill-none stroke-border" strokeWidth="7" />
      <path d="M140 118 H160 V150" className="fill-none stroke-border" strokeWidth="7" />
      <path
        d="M140 70 H176 V150"
        className={running ? 'art-stream stroke-warning' : 'stroke-warning opacity-30'}
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M160 150 V118 H140"
        className={running ? 'art-stream stroke-info' : 'stroke-info opacity-30'}
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="176" cy="154" r="4" className="fill-success" />
    </svg>
  )
}

// ----------------------------------------------------------------- energy art

type FlowTone = 'warning' | 'success' | 'info' | 'primary'

const FLOW_STROKE: Readonly<Record<FlowTone, string>> = {
  warning: 'stroke-warning',
  success: 'stroke-success',
  info: 'stroke-info',
  primary: 'stroke-primary',
}
const FLOW_FILL: Readonly<Record<FlowTone, string>> = {
  warning: 'fill-warning',
  success: 'fill-success',
  info: 'fill-info',
  primary: 'fill-primary',
}
const FLOW_TEXT: Readonly<Record<FlowTone, string>> = {
  warning: 'text-warning',
  success: 'text-success',
  info: 'text-info',
  primary: 'text-primary',
}

/** Below this a flow is "none": the link is drawn still and the value reads as 0. */
export const IDLE_W = 20

interface Pt {
  readonly x: number
  readonly y: number
}

interface Link {
  /** Path from the SOURCE to the sink: the dashes travel along it. */
  readonly from: Pt
  readonly to: Pt
  readonly watts: number
  readonly tone: FlowTone
  /** Label shift along the link, 0..1. */
  readonly at?: number
}

function shorten(from: Pt, to: Pt, by: number): { a: Pt; b: Pt } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)
  const ux = dx / len
  const uy = dy / len
  return {
    a: { x: from.x + ux * by, y: from.y + uy * by },
    b: { x: to.x - ux * by, y: to.y - uy * by },
  }
}

export function wattsText(w: number): string {
  const a = Math.abs(w)
  return a >= 1000 ? `${n(a / 1000, 2)} kW` : `${String(Math.round(a))} W`
}

/** One connection: a still track, the animated flow over it, an arrow head and its power. */
function FlowLink({ link, r }: { readonly link: Link; readonly r: number }): ReactNode {
  const { a, b } = shorten(link.from, link.to, r)
  const active = Math.abs(link.watts) >= IDLE_W
  const at = link.at ?? 0.5
  const mx = a.x + (b.x - a.x) * at
  const my = a.y + (b.y - a.y) * at
  const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  const ax = a.x + (b.x - a.x) * 0.78
  const ay = a.y + (b.y - a.y) * 0.78
  const label = active ? wattsText(link.watts) : '0 W'
  const width = label.length * 6.4 + 10
  return (
    <g>
      <path
        d={`M${String(a.x)} ${String(a.y)} L${String(b.x)} ${String(b.y)}`}
        className="fill-none stroke-border"
        strokeWidth="5"
        strokeLinecap="round"
      />
      {active ? (
        <>
          <path
            d={`M${String(a.x)} ${String(a.y)} L${String(b.x)} ${String(b.y)}`}
            className={`art-stream fill-none ${FLOW_STROKE[link.tone]}`}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d="M-5 -4 L4 0 L-5 4z"
            transform={`translate(${String(ax)} ${String(ay)}) rotate(${String(angle)})`}
            className={FLOW_FILL[link.tone]}
          />
        </>
      ) : null}
      <rect
        x={mx - width / 2}
        y={my - 9}
        width={width}
        height="18"
        rx="9"
        className="fill-surface stroke-border"
        strokeWidth="1"
      />
      <text
        x={mx}
        y={my + 4}
        textAnchor="middle"
        fontSize="11"
        fontWeight="600"
        className={active ? 'fill-foreground' : 'fill-foreground-subtle'}
      >
        {label}
      </text>
    </g>
  )
}

interface NodeProps {
  readonly at: Pt
  readonly r: number
  readonly icon: LucideIcon
  readonly tone: FlowTone | null
  readonly caption: string
  readonly captionAbove?: boolean
}

/** A circle in the machine style (`surface` + `border`), ringed in the tone while it moves power. */
function FlowNode({ at, r, icon: Icon, tone, caption, captionAbove }: NodeProps): ReactNode {
  const size = r * 0.95
  return (
    <g className={tone === null ? 'text-foreground-muted' : FLOW_TEXT[tone]}>
      <circle
        cx={at.x}
        cy={at.y}
        r={r}
        className={`fill-surface ${tone === null ? 'stroke-border' : 'stroke-current'}`}
        strokeWidth="2"
      />
      <Icon
        x={at.x - size / 2}
        y={at.y - size / 2}
        width={size}
        height={size}
        className="stroke-current"
        aria-hidden
      />
      <text
        x={at.x}
        y={captionAbove === true ? at.y - r - 6 : at.y + r + 13}
        textAnchor="middle"
        fontSize="10"
        className="fill-foreground-muted"
      >
        {caption}
      </text>
    </g>
  )
}

export interface EnergyFlows {
  /** PV production, W (>= 0). */
  readonly pv: number
  /** Battery, W: positive charges it, negative discharges it. */
  readonly battery: number
  /** Grid, W: positive imports, negative exports. */
  readonly grid: number
  /** House consumption, W. */
  readonly house: number
  /** The linked heat pump's live power, W; `null` = nothing linked. */
  readonly heatPump: number | null
  readonly soc: number
}

const POS = {
  pv: { x: 58, y: 44 },
  grid: { x: 302, y: 44 },
  battery: { x: 58, y: 150 },
  house: { x: 180, y: 98 },
  /** Tangent to the house circle (26 + 13): a share OF the house, not a branch. */
  heatPump: { x: 208, y: 126 },
} as const

/** The battery cell: the charge level fills it from the bottom, the percentage sits INSIDE. */
function BatteryNode({
  at,
  r,
  soc,
  moving,
}: {
  readonly at: Pt
  readonly r: number
  readonly soc: number
  readonly moving: boolean
}): ReactNode {
  const w = 34
  const h = 44
  const fillH = ((h - 4) * Math.min(Math.max(soc, 0), 100)) / 100
  const x = at.x - w / 2
  const y = at.y - h / 2
  return (
    <g className={moving ? 'text-success' : 'text-foreground-muted'}>
      <circle cx={at.x} cy={at.y} r={r + 4} className="fill-none stroke-border" strokeWidth="1" />
      <rect x={at.x - 6} y={y - 4} width="12" height="4" rx="1.5" className="fill-current" />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx="7"
        className={`fill-surface ${moving ? 'stroke-current' : 'stroke-border'}`}
        strokeWidth="2"
      />
      <rect
        x={x + 2}
        y={y + 2 + (h - 4 - fillH)}
        width={w - 4}
        height={fillH}
        rx="5"
        className="fill-current opacity-25"
      />
      <text
        x={at.x}
        y={at.y + 4}
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        className="fill-foreground"
      >
        {String(Math.round(soc))}%
      </text>
      <text
        x={at.x}
        y={y + h + 14}
        textAnchor="middle"
        fontSize="10"
        className="fill-foreground-muted"
      >
        Batteria
      </text>
    </g>
  )
}

/**
 * PV / battery / grid around the house. The house shows its TOTAL consumption; the linked
 * heat pump is a small circle attached to it: a share of that total, never a second branch.
 */
export function EnergyFlowArt({ flows }: { readonly flows: EnergyFlows }): ReactNode {
  const { pv, battery, grid, heatPump, house } = flows
  const R = 22
  const links: Link[] = [
    { from: POS.pv, to: POS.house, watts: pv, tone: 'warning', at: 0.45 },
    grid >= 0
      ? { from: POS.grid, to: POS.house, watts: grid, tone: 'info', at: 0.45 }
      : {
          from: POS.house,
          to: POS.grid,
          watts: grid,
          tone: 'success',
          at: 0.55,
        },
    battery >= 0
      ? {
          from: POS.house,
          to: POS.battery,
          watts: battery,
          tone: 'success',
          at: 0.55,
        }
      : {
          from: POS.battery,
          to: POS.house,
          watts: battery,
          tone: 'warning',
          at: 0.45,
        },
  ]
  return (
    <svg viewBox="0 0 360 196" aria-hidden="true" className="h-full w-full max-w-[420px]">
      {links.map((link, i) => (
        <FlowLink key={i} link={link} r={R} />
      ))}
      <FlowNode
        at={POS.pv}
        r={R}
        icon={Sun}
        tone={pv >= IDLE_W ? 'warning' : null}
        caption="Fotovoltaico"
        captionAbove
      />
      <FlowNode
        at={POS.grid}
        r={R}
        icon={Zap}
        tone={Math.abs(grid) >= IDLE_W ? (grid >= 0 ? 'info' : 'success') : null}
        caption={
          Math.abs(grid) < IDLE_W ? 'Rete' : grid >= 0 ? 'Rete · da rete' : 'Rete · verso rete'
        }
        captionAbove
      />
      <BatteryNode at={POS.battery} r={R} soc={flows.soc} moving={Math.abs(battery) >= IDLE_W} />
      {heatPump === null ? null : (
        <g className={heatPump >= IDLE_W ? 'text-warning' : 'text-foreground-muted'}>
          <circle
            cx={POS.heatPump.x}
            cy={POS.heatPump.y}
            r="13"
            className={`fill-surface ${heatPump >= IDLE_W ? 'stroke-current' : 'stroke-border'}`}
            strokeWidth="2"
          />
          <Flame
            x={POS.heatPump.x - 6}
            y={POS.heatPump.y - 6}
            width={12}
            height={12}
            className="stroke-current"
            aria-hidden
          />
          <text
            x={POS.heatPump.x + 19}
            y={POS.heatPump.y + 4}
            fontSize="10"
            className="fill-foreground-muted"
          >
            {`PdC ${wattsText(heatPump)}`}
          </text>
        </g>
      )}
      <FlowNode at={POS.house} r={26} icon={House} tone="primary" caption="" />
      <text
        x={POS.house.x}
        y={POS.house.y - 26 - 6}
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        className="fill-foreground"
      >
        {`Casa ${wattsText(house)}`}
      </text>
    </svg>
  )
}
