import type { CSSProperties, ReactElement } from 'react'
import { cn } from '../../../../lib/cn'
import { type StationModule, stationBearingDeg } from './model'
import { STATION_CUP_HUB, STATION_VANE_PIVOT } from './station-geometry'

export interface WeatherStationIllustrationProps {
  readonly modules: readonly StationModule[]
  readonly spinRate: number
  /** Degrees the wind comes from. Null rests the vane on north. */
  readonly bearing: number | null
  readonly className?: string
}

const VIEW_W = 160
const MAST_END_TALL = 134
const MAST_END_SHORT = 76
const FOOT = 14
/** Slowest and fastest cup revolution, so a gale does not strobe. */
const CUP_PERIOD_MIN_SEC = 0.35
const CUP_PERIOD_MAX_SEC = 8
const CUP_TURNS = [0, 120, 240] as const

type StationMotionStyle = CSSProperties &
  Readonly<Record<'--dc-station-period' | '--dc-station-bearing', string>>

function has(modules: readonly StationModule[], id: StationModule): boolean {
  return modules.includes(id)
}

function mastEnd(modules: readonly StationModule[]): number {
  const lower = has(modules, 'shield') || has(modules, 'rain') || has(modules, 'sun')
  return lower ? MAST_END_TALL : MAST_END_SHORT
}

function motionStyle(rate: number, bearingDeg: number | null): StationMotionStyle {
  const raw = rate > 0 ? 1 / rate : 0
  const period = rate > 0 ? Math.min(CUP_PERIOD_MAX_SEC, Math.max(CUP_PERIOD_MIN_SEC, raw)) : 0
  return {
    '--dc-station-period': `${period.toFixed(2)}s`,
    '--dc-station-bearing': `${bearingDeg ?? 0}deg`,
  }
}

function Mast({ end }: { readonly end: number }): ReactElement {
  return (
    <g strokeWidth={3} strokeLinecap="round" className="stroke-foreground-muted">
      <line x1={STATION_CUP_HUB.x} y1={8} x2={STATION_CUP_HUB.x} y2={end} />
      <line x1={STATION_CUP_HUB.x} y1={end} x2={STATION_CUP_HUB.x - 22} y2={end + FOOT} />
      <line x1={STATION_CUP_HUB.x} y1={end} x2={STATION_CUP_HUB.x + 22} y2={end + FOOT} />
    </g>
  )
}

function Cups(): ReactElement {
  const { x, y } = STATION_CUP_HUB
  return (
    <g className="dc-station-cups" data-testid="dc-station-module-anemometer">
      {CUP_TURNS.map((turn) => (
        <g key={turn} transform={`rotate(${turn} ${x} ${y})`}>
          <line
            x1={x}
            y1={y}
            x2={x}
            y2={y - 14}
            strokeWidth={1.6}
            strokeLinecap="round"
            className="stroke-foreground"
          />
          <ellipse
            cx={x}
            cy={y - 16}
            rx={6}
            ry={3.6}
            strokeWidth={1.2}
            className="fill-info stroke-foreground"
          />
        </g>
      ))}
      <circle cx={x} cy={y} r={3} className="fill-foreground" />
    </g>
  )
}

function Vane(): ReactElement {
  const { x, y } = STATION_VANE_PIVOT
  return (
    <g className="dc-station-vane" data-testid="dc-station-module-vane">
      <path
        d={`M${x} ${y - 16} L${x + 5} ${y} L${x} ${y - 4} L${x - 5} ${y} Z`}
        className="fill-foreground"
      />
      <path
        d={`M${x} ${y + 3} L${x + 11} ${y + 16} L${x} ${y + 12} L${x - 11} ${y + 16} Z`}
        className="fill-foreground-muted"
      />
      <circle cx={x} cy={y} r={3.2} strokeWidth={1.4} className="fill-surface stroke-foreground" />
    </g>
  )
}

function Shield(): ReactElement {
  return (
    <g data-testid="dc-station-module-shield">
      <rect
        x={68}
        y={86}
        width={24}
        height={22}
        rx={4}
        strokeWidth={1.5}
        className="fill-surface stroke-foreground-muted"
      />
      <path
        d="M72 92 H88 M72 97 H88 M72 102 H88"
        strokeWidth={1.1}
        className="stroke-foreground-muted"
      />
    </g>
  )
}

function RainGauge(): ReactElement {
  return (
    <g data-testid="dc-station-module-rain">
      <line x1={80} y1={116} x2={42} y2={116} strokeWidth={2} className="stroke-foreground-muted" />
      <path d="M30 100 H54 L48 116 H36 Z" strokeWidth={1.5} className="fill-surface stroke-info" />
      <rect
        x={36}
        y={116}
        width={12}
        height={12}
        rx={1.5}
        strokeWidth={1.5}
        className="fill-surface stroke-info"
      />
      <circle cx={38} cy={94} r={1.3} className="fill-info" />
      <circle cx={46} cy={90} r={1.1} className="fill-info" />
    </g>
  )
}

function SunSensor(): ReactElement {
  return (
    <g data-testid="dc-station-module-sun">
      <line x1={80} y1={74} x2={108} y2={70} strokeWidth={2} className="stroke-foreground-muted" />
      <g transform="rotate(-14 120 72)">
        <rect
          x={106}
          y={64}
          width={28}
          height={14}
          rx={2}
          strokeWidth={1.4}
          className="fill-surface stroke-primary"
        />
        <path
          d="M110 68 H130 M110 71 H130 M110 74 H130"
          strokeWidth={1}
          className="stroke-primary"
        />
      </g>
      <circle cx={142} cy={58} r={4.5} strokeWidth={1.3} className="fill-none stroke-warning" />
      <path
        d="M142 51 V48 M148 58 H151 M142 65 V68 M136 58 H133"
        strokeWidth={1.2}
        strokeLinecap="round"
        className="stroke-warning"
      />
    </g>
  )
}

/**
 * The outdoor station: a mast and only the modules the readings support.
 * Cups spin with the wind; the vane eases to the bearing. Both are CSS
 * transforms — nothing moves from a timer.
 */
export function WeatherStationIllustration({
  modules,
  spinRate,
  bearing,
  className,
}: WeatherStationIllustrationProps): ReactElement {
  const end = mastEnd(modules)
  const deg = stationBearingDeg(bearing)
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${end + FOOT + 8}`}
      aria-hidden
      data-testid="dc-station-drawing"
      data-modules={modules.join(' ')}
      data-spin={spinRate > 0}
      data-rate={spinRate}
      // ui-check-ok: computed geometry, cup period and vane bearing from the readings
      style={motionStyle(spinRate, deg)}
      className={cn('dc-station text-foreground', className)}
    >
      <Mast end={end} />
      {has(modules, 'rain') ? <RainGauge /> : null}
      {has(modules, 'sun') ? <SunSensor /> : null}
      {has(modules, 'shield') ? <Shield /> : null}
      {has(modules, 'vane') ? <Vane /> : null}
      {has(modules, 'anemometer') ? <Cups /> : null}
    </svg>
  )
}
