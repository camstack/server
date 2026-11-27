import type { ReactElement } from 'react'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardCommonActions, CardOrientation } from '../../shell/model'
import { READING_TILES_GRID, ReadingTile } from './ReadingTile'
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
            <ul className={READING_TILES_GRID}>
              {model.readings.map((reading) => (
                <li key={reading.id} className="min-w-0">
                  <ReadingTile
                    reading={reading}
                    selected={reading.id === selectedId}
                    dimmed={selectedId !== null && reading.id !== selectedId}
                    onSelect={onSelect}
                    testId="dc-grid-tile"
                  />
                </li>
              ))}
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
