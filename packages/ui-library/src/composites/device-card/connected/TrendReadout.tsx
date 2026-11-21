import type { ReadingQuantity } from '@camstack/types'
import type { ReactElement } from 'react'
import { useUiText } from '../../../contexts/ui-text'
import { useUnitPreferences } from '../../../contexts/unit-preferences'
import { preferenceForQuantity } from '../../../lib/unit-preferences'
import { Sparkline, type SparklinePoint } from '../../charts/Sparkline'
import { trendReadout } from './trend-readout'

const HOUR_MS = 3_600_000

export interface TrendReadoutViewProps {
  readonly points: readonly SparklinePoint[]
  /** Accessible name of the curve (what it measures). */
  readonly label: string
  readonly quantity?: ReadingQuantity | undefined
  /** The cap's declared unit when it names no known quantity. */
  readonly unit?: string | null | undefined
  /** The span the points cover, ending now. */
  readonly windowMs: number
  readonly testId: string
}

/**
 * A device card's footer trend with its scale: the Y min and max, the span in time
 * (start to now), the unit and the latest value. Nothing when the series did not
 * answer with at least two samples: an unanswered read has no scale.
 */
export function TrendReadoutView({
  points,
  label,
  quantity,
  unit,
  windowMs,
  testId,
}: TrendReadoutViewProps): ReactElement | null {
  const t = useUiText()
  const unitPreferences = useUnitPreferences()
  const readout = trendReadout({
    points,
    quantity,
    unit,
    preference:
      quantity === undefined ? undefined : preferenceForQuantity(unitPreferences, quantity),
  })
  if (readout === null) return null
  const hours = Math.round(windowMs / HOUR_MS)
  return (
    <span data-testid={testId} className="flex justify-center">
      <span className="inline-grid grid-cols-[auto_1fr] items-stretch gap-x-1 gap-y-0.5 text-xs tabular-nums text-foreground-muted">
        <span className="col-start-2 text-right text-foreground">
          <b data-testid="dc-trend-current" className="font-semibold">
            {readout.current}
          </b>
          {readout.unit === '' ? null : <small> {readout.unit}</small>}
        </span>
        <span aria-hidden className="flex flex-col justify-between leading-none">
          <span data-testid="dc-trend-max">{readout.max}</span>
          <span data-testid="dc-trend-min">{readout.min}</span>
        </span>
        <Sparkline
          points={[...points]}
          ariaLabel={label}
          token="primary"
          {...(quantity === undefined
            ? {}
            : {
                quantity,
                displayPreference: preferenceForQuantity(unitPreferences, quantity),
              })}
          zeroBased={false}
          height={36}
          widthClassName="w-40 @lg:w-56"
        />
        <span className="col-start-2 flex justify-between">
          <span data-testid="dc-trend-start">
            {t('uiLibrary.deviceCard.trend.start', '{{hours}} h ago', {
              hours,
            })}
          </span>
          <span>{t('uiLibrary.deviceCard.trend.now', 'now')}</span>
        </span>
      </span>
    </span>
  )
}
