import type { ReadingQuantity } from '@dominevo/types'
import type { ReactElement } from 'react'
import { useUiText } from '../../../contexts/ui-text'
import { useUnitPreferences } from '../../../contexts/unit-preferences'
import { resolveSensorDisplay } from '../../../lib/resolve-sensor-display'
import { preferenceForQuantity } from '../../../lib/unit-preferences'
import { Sparkline, type SparklinePoint } from '../../charts/Sparkline'
import { useRoleDisplayDefaults } from '../../device-item/role-display-defaults-context'
import type { ReadingDisplaySubject } from '../../hero-model/measurement-display'
import { trendReadout } from './trend-readout'

const HOUR_MS = 3_600_000

export interface TrendReadoutViewProps {
  readonly points: readonly SparklinePoint[]
  /** Accessible name of the curve (what it measures). */
  readonly label: string
  readonly quantity?: ReadingQuantity | undefined
  /** The cap's declared unit when it names no known quantity. */
  readonly unit?: string | null | undefined
  /** The device the card draws: its display override and role default shape the unit. */
  readonly subject?: ReadingDisplaySubject | null | undefined
  /** The card already shows this reading as its big value: hide the latest value from a screen reader. */
  readonly currentAriaHidden?: boolean | undefined
  /** The span the points cover, ending now. */
  readonly windowMs: number
  readonly testId: string
  /** A tile-sized line: the curve alone at the width it is given, no scale. */
  readonly compact?: boolean | undefined
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
  subject,
  currentAriaHidden = false,
  windowMs,
  testId,
  compact = false,
}: TrendReadoutViewProps): ReactElement | null {
  const t = useUiText()
  const unitPreferences = useUnitPreferences()
  const roleDefaults = useRoleDisplayDefaults()
  const role = subject?.role ?? null
  const roleDefault = role === null ? undefined : roleDefaults[role]
  const format =
    quantity === undefined
      ? undefined
      : resolveSensorDisplay({
          ...(subject?.display === undefined ? {} : { display: subject.display }),
          ...(roleDefault === undefined ? {} : { roleDefault }),
          quantity,
          unitPreferences,
        }).format
  const readout = trendReadout({ points, quantity, unit, format })
  if (readout === null) return null
  if (compact) {
    return (
      <span data-testid={testId} className="flex w-full">
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
          height={24}
          widthClassName="w-full"
        />
      </span>
    )
  }
  const hours = Math.round(windowMs / HOUR_MS)
  return (
    <span data-testid={testId} className="flex justify-center">
      <span className="inline-grid grid-cols-[auto_1fr] items-stretch gap-x-1 gap-y-0.5 text-xs tabular-nums text-foreground-muted">
        <span
          className="col-start-2 text-right text-foreground"
          {...(currentAriaHidden ? { 'aria-hidden': true } : {})}
        >
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
