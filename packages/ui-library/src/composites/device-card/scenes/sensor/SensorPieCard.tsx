import type { HeroMeasurementQuantity } from '@camstack/types'
import { type KeyboardEvent, type ReactElement, type ReactNode, useId } from 'react'
import { cn } from '../../../../lib/cn'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardCommon, CardCommonActions, CardOrientation, CardState } from '../../shell/model'
import { PIE_CENTRE, PIE_RADIUS, type PieWedge, pieGeometry, type ReadingState } from './pie-model'
import { SENSOR_PIE_CSS } from './pie-css'

/** One wedge as the operator reads it: already in their display unit. */
export interface PieReading {
  /** Stable key, also what a tap reports. */
  readonly id: string
  readonly quantity: HeroMeasurementQuantity
  /** "142", "Active", "—" when it has not reported. */
  readonly value: string
  readonly unit: string | null
  /** The short name under the value ("Light", "Motion"). */
  readonly label: string
  readonly state: ReadingState
}

export interface SensorPieCardModel {
  readonly common: CardCommon
  /** The state corner: the leading reading's word and tone. */
  readonly state: CardState
  /** One wedge each, the role's own reading first. */
  readonly readings: readonly PieReading[]
  /** "Updated · 2 min ago", top-left of the scene; `null` = never observed. */
  readonly updated: string | null
}

export interface SensorPieCardProps {
  readonly model: SensorPieCardModel
  readonly actions?: CardCommonActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
  /** A wedge was tapped: that reading's history. */
  readonly onSelect?: (id: string) => void
  /** The reading whose wedge is highlighted (the others dim); `null` = none. */
  readonly selectedId?: string | null
  /** Drawn inline below the pie, inside the card: the selected reading's chart. */
  readonly detail?: ReactNode
}

/**
 * What tints a wedge and colours its edge: the quantity's theme token, ONE per
 * quantity (literal classes, so Tailwind sees them). Motion takes the series
 * violet because the brand orange reads as the warning amber next to it; the warm
 * pair that remains (power, illuminance) rarely sits on one sensor.
 */
const WEDGE_FILL: Readonly<Record<HeroMeasurementQuantity, string>> = {
  temperature: 'fill-danger/25 stroke-danger/60',
  humidity: 'fill-info/25 stroke-info/60',
  illuminance: 'fill-warning/25 stroke-warning/60',
  power: 'fill-primary/25 stroke-primary/60',
  motion: 'fill-chart-series-f/25 stroke-chart-series-f/60',
  contact: 'fill-success/25 stroke-success/60',
  text: 'fill-foreground-muted/25 stroke-foreground-muted/60',
  co2: 'fill-chart-series-a/25 stroke-chart-series-a/60',
  voc: 'fill-chart-series-b/25 stroke-chart-series-b/60',
  pm25: 'fill-chart-series-c/25 stroke-chart-series-c/60',
  pm10: 'fill-chart-series-e/25 stroke-chart-series-e/60',
  aqi: 'fill-chart-series-d/25 stroke-chart-series-d/60',
}
/** The selected wedge: a stronger tint and a full-colour edge, still its own quantity's. */
const WEDGE_FILL_SELECTED: Readonly<Record<HeroMeasurementQuantity, string>> = {
  temperature: 'fill-danger/45 stroke-danger',
  humidity: 'fill-info/45 stroke-info',
  illuminance: 'fill-warning/45 stroke-warning',
  power: 'fill-primary/45 stroke-primary',
  motion: 'fill-chart-series-f/45 stroke-chart-series-f',
  contact: 'fill-success/45 stroke-success',
  text: 'fill-foreground-muted/45 stroke-foreground-muted',
  co2: 'fill-chart-series-a/45 stroke-chart-series-a',
  voc: 'fill-chart-series-b/45 stroke-chart-series-b',
  pm25: 'fill-chart-series-c/45 stroke-chart-series-c',
  pm10: 'fill-chart-series-e/45 stroke-chart-series-e',
  aqi: 'fill-chart-series-d/45 stroke-chart-series-d',
}
/** Colours the quantity's motion (it draws in `currentColor`). */
const WEDGE_FX_TEXT: Readonly<Record<HeroMeasurementQuantity, string>> = {
  temperature: 'text-danger',
  humidity: 'text-info',
  illuminance: 'text-warning',
  power: 'text-primary',
  motion: 'text-chart-series-f',
  contact: 'text-success',
  text: 'text-foreground-muted',
  co2: 'text-chart-series-a',
  voc: 'text-chart-series-b',
  pm25: 'text-chart-series-c',
  pm10: 'text-chart-series-e',
  aqi: 'text-chart-series-d',
}

/** The size of the value, so a word and a long number stay inside the wedge. */
function valueSizeClass(n: number, value: string): string {
  if (value.length > 6) return 'text-[9px]'
  if (n >= 5 || value.length > 4) return 'text-[12px]'
  return n >= 3 ? 'text-[16px]' : 'text-[20px]'
}

function onKey(handler: () => void): (e: KeyboardEvent<SVGGElement>) => void {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handler()
    }
  }
}

interface WedgeFxProps {
  readonly quantity: HeroMeasurementQuantity
  readonly at: PieWedge['centroid']
}

/** The quantity's motion, drawn inside the clipped wedge. */
function WedgeFx({ quantity, at }: WedgeFxProps): ReactElement | null {
  switch (quantity) {
    case 'motion':
      return (
        <g data-fx="rings" className="dc-pie-fx">
          {[0, 1, 2].map((i) => (
            <circle
              key={i}
              cx={at.x}
              cy={at.y}
              r={8}
              className={cn('dc-pie-ring fill-none stroke-current', `dc-pie-step-${String(i)}`)}
            />
          ))}
        </g>
      )
    case 'humidity':
      return (
        <g data-fx="drops" className="dc-pie-fx">
          {[-14, 0, 14].map((dx, i) => (
            <ellipse
              key={dx}
              cx={at.x + dx}
              cy={at.y - 26}
              rx={1.6}
              ry={3.2}
              className={cn('dc-pie-drop fill-current', `dc-pie-step-${String(i)}`)}
            />
          ))}
        </g>
      )
    case 'temperature':
      return (
        <g data-fx="wisps" className="dc-pie-fx">
          {[-12, 0, 12].map((dx, i) => (
            <path
              key={dx}
              d={`M${String(at.x + dx)} ${String(at.y + 24)} q4 -6 0 -12`}
              className={cn('dc-pie-wisp fill-none stroke-current', `dc-pie-step-${String(i)}`)}
            />
          ))}
        </g>
      )
    case 'power':
      return (
        <g data-fx="flow" className="dc-pie-fx">
          <line
            x1={PIE_CENTRE}
            y1={PIE_CENTRE}
            x2={at.x}
            y2={at.y}
            className="dc-pie-flow stroke-current"
          />
        </g>
      )
    default:
      return null
  }
}

interface WedgeProps {
  readonly wedge: PieWedge
  readonly count: number
  readonly reading: PieReading
  readonly clipId: string
  readonly selected: boolean
  readonly dimmed: boolean
  readonly onSelect: ((id: string) => void) | undefined
}

function Wedge({
  wedge,
  count,
  reading,
  clipId,
  selected,
  dimmed,
  onSelect,
}: WedgeProps): ReactElement {
  const { centroid: at } = wedge
  const tap = (): void => onSelect?.(reading.id)
  return (
    <g
      data-testid="dc-pie-wedge"
      data-quantity={reading.quantity}
      data-state={reading.state}
      data-selected={selected ? 'true' : undefined}
      role="button"
      aria-pressed={selected}
      tabIndex={0}
      aria-label={`${reading.label} ${reading.value}${reading.unit === null ? '' : ` ${reading.unit}`}`}
      className={cn(
        'dc-pie-wedge cursor-pointer transition-opacity',
        WEDGE_FX_TEXT[reading.quantity],
        dimmed && 'opacity-40',
      )}
      onClick={tap}
      onKeyDown={onKey(tap)}
    >
      <clipPath id={clipId}>
        <path d={wedge.path} />
      </clipPath>
      <path
        d={wedge.path}
        className={cn(
          reading.state === 'empty'
            ? 'fill-surface stroke-foreground-subtle dc-pie-empty'
            : selected
              ? WEDGE_FILL_SELECTED[reading.quantity]
              : WEDGE_FILL[reading.quantity],
          reading.state === 'active' && 'dc-pie-breathe',
        )}
        strokeWidth={selected ? 3 : 1.5}
      />
      {reading.state === 'active' ? (
        <g clipPath={`url(#${clipId})`}>
          <WedgeFx quantity={reading.quantity} at={at} />
        </g>
      ) : null}
      <text
        x={at.x}
        y={at.y - 2}
        textAnchor="middle"
        className={cn(
          'font-semibold tabular-nums',
          reading.state === 'empty' ? 'fill-foreground-muted' : 'fill-foreground',
          valueSizeClass(count, reading.value),
        )}
      >
        {reading.value}
        {reading.unit === null ? null : (
          <tspan dx={1.5} className="fill-foreground-muted text-[8px] font-normal">
            {reading.unit}
          </tspan>
        )}
      </text>
      <text x={at.x} y={at.y + 10} textAnchor="middle" className="fill-foreground-muted text-[8px]">
        {reading.label}
      </text>
    </g>
  )
}

/**
 * A sensor with several readings: a pie of equal wedges from 12 o'clock, each
 * tinted by its quantity, its value, unit and short name at the wedge's centre. A
 * reading that is on or alarming breathes, with its quantity's motion clipped
 * inside the wedge; one with no data is a dashed wedge with a "—". Tapping a
 * wedge highlights it (the others dim) and draws its history below the pie. Seven or more readings are `SensorGridCard`.
 */
export function SensorPieCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
  onSelect,
  selectedId = null,
  detail = null,
}: SensorPieCardProps): ReactElement {
  const uid = useId()
  const count = model.readings.length
  const wedges = pieGeometry(count)
  const lead = model.readings[0]
  return (
    <DeviceCard
      kind="sensor"
      common={model.common}
      orientation={orientation}
      showName={showName}
      state={model.state}
      activity={lead?.quantity ?? 'sensor'}
      {...(actions === undefined ? {} : { actions })}
      scene={{
        fx: null,
        columns: {},
        image: (
          <div
            data-testid="dc-sensor-pie"
            data-wedges={count}
            className="relative flex w-full flex-col items-center justify-center gap-3"
          >
            <style>{SENSOR_PIE_CSS}</style>
            {model.updated === null ? null : (
              <span
                data-testid="dc-pie-updated"
                className="absolute left-0 top-0 text-xs text-foreground-muted"
              >
                {model.updated}
              </span>
            )}
            <svg
              viewBox="0 0 200 200"
              role="group"
              aria-label={model.common.name}
              className="aspect-square w-full max-w-72"
            >
              <circle
                cx={PIE_CENTRE}
                cy={PIE_CENTRE}
                r={PIE_RADIUS + 2}
                className="fill-surface stroke-border"
                strokeWidth={1}
              />
              {model.readings.map((reading, i) => {
                const wedge = wedges[i]
                return wedge === undefined ? null : (
                  <Wedge
                    key={reading.id}
                    wedge={wedge}
                    count={count}
                    reading={reading}
                    clipId={`${uid}-w${String(i)}`}
                    selected={reading.id === selectedId}
                    dimmed={selectedId !== null && reading.id !== selectedId}
                    onSelect={onSelect}
                  />
                )
              })}
            </svg>
            {detail === null ? null : (
              <div data-testid="dc-pie-detail" className="flex w-full flex-col items-center gap-3">
                {detail}
              </div>
            )}
          </div>
        ),
      }}
    />
  )
}
