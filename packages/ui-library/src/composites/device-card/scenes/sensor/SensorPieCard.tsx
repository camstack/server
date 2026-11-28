import type { HeroMeasurementQuantity } from '@dominevo/types'
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { cn } from '../../../../lib/cn'
import type { SceneVisual } from '../../../hero-scene/types'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardCommon, CardCommonActions, CardOrientation, CardState } from '../../shell/model'
import { MeasurementFx } from '../../illustrations/MeasurementFx'
import { type PieWedge, pieGeometry, type ReadingState, wedgeClipPolygon } from './pie-model'
import { readingClasses } from './reading-colour'
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
  /** The reading's own backdrop motion, the single-reading card's (`measurementVisual`); `null` = still. */
  readonly visual?: SceneVisual | null
  /** The reading's last day, the single-reading card's `SensorTrend`; absent until it answers. */
  readonly trend?: ReactNode
  /** The chart-palette slot (`assignReadingSlots`) the wedge, tile and history chart share; absent = the quantity's own. */
  readonly slot?: number
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

interface WedgeProps {
  readonly wedge: PieWedge
  readonly count: number
  readonly reading: PieReading
  readonly selected: boolean
  readonly dimmed: boolean
  readonly onSelect: ((id: string) => void) | undefined
}

function Wedge({ wedge, count, reading, selected, dimmed, onSelect }: WedgeProps): ReactElement {
  const { centroid: at } = wedge
  const classes = readingClasses(reading)
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
      className={cn('dc-pie-wedge cursor-pointer transition-opacity', dimmed && 'opacity-40')}
      onClick={tap}
      onKeyDown={onKey(tap)}
    >
      <path
        d={wedge.path}
        className={cn(
          reading.state === 'empty'
            ? 'fill-surface stroke-foreground-subtle dc-pie-empty'
            : selected
              ? classes.wedgeSelected
              : classes.wedge,
          reading.state === 'active' && 'dc-pie-breathe',
        )}
        strokeWidth={selected ? 3 : 1.5}
      />
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
 * A sensor with two to six readings: a pie of equal wedges from 12 o'clock, each in
 * its own chart-palette colour, its value, unit and short name at the wedge's centre.
 * Each wedge that has a value carries its reading's own motion (the single-reading card's
 * backdrop), clipped to the wedge; a reading with no data is a still, dashed wedge with a "—". Tapping
 * a wedge highlights it (the others dim) and draws its history below the pie. This is
 * the ONLY layout of such a card: seven or more readings are `SensorGridCard`.
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
            <div className="relative isolate aspect-square w-full max-w-72 overflow-hidden rounded-full border border-border bg-surface">
              {model.readings.map((reading, i) => {
                const wedge = wedges[i]
                return wedge === undefined ||
                  reading.visual == null ||
                  reading.state === 'empty' ? null : (
                  <div
                    key={reading.id}
                    data-testid="dc-pie-fx"
                    data-quantity={reading.quantity}
                    className={cn(
                      'pointer-events-none absolute inset-0 transition-opacity',
                      selectedId !== null && reading.id !== selectedId && 'opacity-40',
                    )}
                    // ui-check-ok: the wedge's clip outline is geometry, not a colour or spacing
                    style={{ clipPath: wedgeClipPolygon(wedge) }}
                  >
                    <MeasurementFx visual={reading.visual} />
                  </div>
                )
              })}
              <svg
                viewBox="0 0 200 200"
                role="group"
                aria-label={model.common.name}
                className="absolute inset-0 size-full"
              >
                {model.readings.map((reading, i) => {
                  const wedge = wedges[i]
                  return wedge === undefined ? null : (
                    <Wedge
                      key={reading.id}
                      wedge={wedge}
                      count={count}
                      reading={reading}
                      selected={reading.id === selectedId}
                      dimmed={selectedId !== null && reading.id !== selectedId}
                      onSelect={onSelect}
                    />
                  )
                })}
              </svg>
            </div>
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
