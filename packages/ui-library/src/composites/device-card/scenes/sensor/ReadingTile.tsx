import type { ReactElement } from 'react'
import { cn } from '../../../../lib/cn'
import { MeasurementFx } from '../../illustrations/MeasurementFx'
import { readingClasses } from './reading-colour'
import type { PieReading } from './SensorPieCard'

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
 * reading with no data is a dashed tile with a "—". The grid draws it.
 */
export function ReadingTile({
  reading,
  selected,
  dimmed,
  onSelect,
  testId,
}: ReadingTileProps): ReactElement {
  const classes = readingClasses(reading)
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
            ? classes.tileSelected
            : classes.tile,
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
