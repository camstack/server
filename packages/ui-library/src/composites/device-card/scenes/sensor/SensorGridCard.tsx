import type { HeroMeasurementQuantity } from '@camstack/types'
import type { ReactElement } from 'react'
import { cn } from '../../../../lib/cn'
import { MeasurementFx } from '../../illustrations/MeasurementFx'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardCommonActions, CardOrientation } from '../../shell/model'
import type { SensorPieCardModel } from './SensorPieCard'

export interface SensorGridCardProps {
  readonly model: SensorPieCardModel
  readonly actions?: CardCommonActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
  /** A tile was tapped: that reading's history. */
  readonly onSelect?: (id: string) => void
  /** The reading whose tile is highlighted (the others dim); `null` = none. */
  readonly selectedId?: string | null
  /** Drawn inline below the grid, inside the card: the selected reading's chart. */
  readonly detail?: ReactElement | null
}

/** A tile's tint and edge: the quantity's theme token, the same one its pie wedge uses (literal classes, so Tailwind sees them). */
const TILE_TONE: Readonly<Record<HeroMeasurementQuantity, string>> = {
  temperature: 'bg-danger/10 border-danger/40',
  humidity: 'bg-info/10 border-info/40',
  illuminance: 'bg-warning/10 border-warning/40',
  power: 'bg-primary/10 border-primary/40',
  motion: 'bg-chart-series-f/10 border-chart-series-f/40',
  contact: 'bg-success/10 border-success/40',
  text: 'bg-foreground-muted/10 border-foreground-muted/40',
  co2: 'bg-chart-series-a/10 border-chart-series-a/40',
  voc: 'bg-chart-series-b/10 border-chart-series-b/40',
  pm25: 'bg-chart-series-c/10 border-chart-series-c/40',
  pm10: 'bg-chart-series-e/10 border-chart-series-e/40',
  aqi: 'bg-chart-series-d/10 border-chart-series-d/40',
}
/** The selected tile: a stronger tint and a full-colour edge. */
const TILE_SELECTED: Readonly<Record<HeroMeasurementQuantity, string>> = {
  temperature: 'bg-danger/25 border-danger',
  humidity: 'bg-info/25 border-info',
  illuminance: 'bg-warning/25 border-warning',
  power: 'bg-primary/25 border-primary',
  motion: 'bg-chart-series-f/25 border-chart-series-f',
  contact: 'bg-success/25 border-success',
  text: 'bg-foreground-muted/25 border-foreground-muted',
  co2: 'bg-chart-series-a/25 border-chart-series-a',
  voc: 'bg-chart-series-b/25 border-chart-series-b',
  pm25: 'bg-chart-series-c/25 border-chart-series-c',
  pm10: 'bg-chart-series-e/25 border-chart-series-e',
  aqi: 'bg-chart-series-d/25 border-chart-series-d',
}

/**
 * A sensor with many readings (seven or more, past what a pie shows legibly): a
 * grid of tiles, one per reading, as many columns as the card's width holds (two
 * on a phone). Each tile is tinted by its quantity like a pie wedge: value and
 * unit big, the short name under it; a reading with no data is a dashed tile with
 * a "—". Tapping a tile highlights it (the others dim) and draws its history below
 * the grid.
 */
export function SensorGridCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
  onSelect,
  selectedId = null,
  detail = null,
}: SensorGridCardProps): ReactElement {
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
            data-testid="dc-sensor-grid"
            data-tiles={model.readings.length}
            className="flex w-full flex-col gap-3"
          >
            {model.updated === null ? null : (
              <span data-testid="dc-grid-updated" className="text-xs text-foreground-muted">
                {model.updated}
              </span>
            )}
            <ul className="grid w-full grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-2">
              {model.readings.map((reading) => {
                const selected = reading.id === selectedId
                return (
                  <li key={reading.id} className="min-w-0">
                    {/* ui-check-ok: a selectable reading tile (the pie's wedge as a tile), not an action button */}
                    <button
                      type="button"
                      data-testid="dc-grid-tile"
                      data-quantity={reading.quantity}
                      data-state={reading.state}
                      data-selected={selected ? 'true' : undefined}
                      aria-pressed={selected}
                      aria-label={`${reading.label} ${reading.value}${reading.unit === null ? '' : ` ${reading.unit}`}`}
                      onClick={() => onSelect?.(reading.id)}
                      className={cn(
                        'relative isolate flex w-full min-w-0 cursor-pointer overflow-hidden flex-col items-start gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-opacity',
                        reading.state === 'empty'
                          ? 'border-dashed border-foreground-subtle bg-surface'
                          : selected
                            ? TILE_SELECTED[reading.quantity]
                            : TILE_TONE[reading.quantity],
                        selectedId !== null && !selected && 'opacity-40',
                      )}
                    >
                      {reading.visual == null ? null : <MeasurementFx visual={reading.visual} />}
                      <span className="max-w-full truncate text-xs text-foreground-muted">
                        {reading.label}
                      </span>
                      <span
                        className={cn(
                          'max-w-full truncate text-lg font-semibold tabular-nums',
                          reading.state === 'empty' ? 'text-foreground-muted' : 'text-foreground',
                        )}
                      >
                        {reading.value}
                        {reading.unit === null ? null : (
                          <span className="ml-1 text-xs font-normal text-foreground-muted">
                            {reading.unit}
                          </span>
                        )}
                      </span>
                      {reading.trend ?? null}
                    </button>
                  </li>
                )
              })}
            </ul>
            {detail === null ? null : (
              <div data-testid="dc-grid-detail" className="flex w-full flex-col items-center gap-3">
                {detail}
              </div>
            )}
          </div>
        ),
      }}
    />
  )
}
