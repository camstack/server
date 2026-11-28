import type { HeroMeasurementQuantity } from '@dominevo/types'
import type { ReactElement } from 'react'
import { cn } from '../../../../lib/cn'
import { MeasurementFx } from '../../illustrations/MeasurementFx'
import type { PieReading } from './SensorPieCard'

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

export interface ReadingTileProps {
  readonly reading: PieReading
  readonly selected: boolean
  /** Another reading is open: this one dims. */
  readonly dimmed: boolean
  readonly onSelect?: ((id: string) => void) | undefined
  readonly testId: string
}

/**
 * One reading as a tile: its quantity's tint, value and unit big, the short name above,
 * the single-reading card's own motion behind it and its last-day trend under it. A
 * reading with no data is a dashed tile with a "—". The grid and the pie's legend draw it.
 */
export function ReadingTile({
  reading,
  selected,
  dimmed,
  onSelect,
  testId,
}: ReadingTileProps): ReactElement {
  return (
    // ui-check-ok: a selectable reading tile (the pie's wedge as a tile), not an action button
    <button
      type="button"
      data-testid={testId}
      data-quantity={reading.quantity}
      data-state={reading.state}
      data-selected={selected ? 'true' : undefined}
      aria-pressed={selected}
      aria-label={`${reading.label} ${reading.value}${reading.unit === null ? '' : ` ${reading.unit}`}`}
      onClick={() => onSelect?.(reading.id)}
      className={cn(
        'relative isolate flex w-full min-w-0 cursor-pointer flex-col items-start gap-0.5 overflow-hidden rounded-lg border px-2.5 py-2 text-left transition-opacity',
        reading.state === 'empty'
          ? 'border-dashed border-foreground-subtle bg-surface'
          : selected
            ? TILE_SELECTED[reading.quantity]
            : TILE_TONE[reading.quantity],
        dimmed && 'opacity-40',
      )}
    >
      {reading.visual == null ? null : <MeasurementFx visual={reading.visual} />}
      <span className="max-w-full truncate text-xs text-foreground-muted">{reading.label}</span>
      <span
        className={cn(
          'max-w-full truncate text-lg font-semibold tabular-nums',
          reading.state === 'empty' ? 'text-foreground-muted' : 'text-foreground',
        )}
      >
        {reading.value}
        {reading.unit === null ? null : (
          <span className="ml-1 text-xs font-normal text-foreground-muted">{reading.unit}</span>
        )}
      </span>
      {reading.trend ?? null}
    </button>
  )
}

/** The columns a row of reading tiles holds: as many as the card's width fits (two on a phone). */
export const READING_TILES_GRID =
  'grid w-full grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-2'
