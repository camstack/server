import { ChevronLeft, ChevronRight } from 'lucide-react'
import { type ReactElement, useMemo } from 'react'
import { cn } from '../../../lib/cn'
import { type UiTextFn, useUiText } from '../../../contexts/ui-text'
import { Button } from '../../../primitives/button'
import { IconButton } from '../../../primitives/icon-button'
import { Skeleton } from '../../../primitives/skeleton'
import type { ChartBand, ChartBandTone } from '../../charts/chart-bands'
import { chartLocale } from '../../charts/chart-data'
import { TimeSeriesChart, type TimeSeriesDef } from '../../charts/TimeSeriesChart'
import type { EnergyFlowSource, EnergyFlowSpan } from '../connected/energy-day'

/** How the selected day's read stands: not answered, answered with data, answered with none, or failed. */
export type EnergyDayStatus = 'pending' | 'ready' | 'empty' | 'error'

export interface EnergyDayPanelProps {
  /** Local midnight that opens the selected day. */
  readonly dayStart: number
  readonly isToday: boolean
  /** The next day exists only up to today. */
  readonly canNext: boolean
  readonly onPrev: () => void
  readonly onNext: () => void
  readonly onToday: () => void
  readonly status: EnergyDayStatus
  /** Powers in W over the day: solar, house, grid, battery, heat pump (those the system has). */
  readonly powerSeries: readonly TimeSeriesDef[]
  /** State of charge in %, when the system has a storage. */
  readonly socSeries: readonly TimeSeriesDef[]
  readonly flowSpans: readonly EnergyFlowSpan[]
  /** The x axis: the whole local day. */
  readonly range: { readonly from: number; readonly to: number }
}

const SOURCE_TONE: Readonly<Record<EnergyFlowSource, ChartBandTone>> = {
  'from-grid': 'info',
  'to-grid': 'success',
  'from-battery': 'warning',
  'to-battery': 'neutral',
}

function sourceLabel(source: EnergyFlowSource, t: UiTextFn): string {
  switch (source) {
    case 'from-grid':
      return t('uiLibrary.deviceCard.energy.day.fromGrid', 'From the grid')
    case 'to-grid':
      return t('uiLibrary.deviceCard.energy.day.toGrid', 'To the grid')
    case 'from-battery':
      return t('uiLibrary.deviceCard.energy.day.fromBattery', 'From the battery')
    case 'to-battery':
      return t('uiLibrary.deviceCard.energy.day.toBattery', 'To the battery')
  }
}

const DAY_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
}

/** Spelled out so Tailwind finds every class; mirrors the band tones the chart paints. */
const SOURCE_SWATCH: Readonly<Record<EnergyFlowSource, string>> = {
  'from-grid': 'bg-info',
  'to-grid': 'bg-success',
  'from-battery': 'bg-warning',
  'to-battery': 'bg-foreground-subtle',
}

const SOURCE_ORDER: readonly EnergyFlowSource[] = [
  'from-grid',
  'to-grid',
  'from-battery',
  'to-battery',
]

/** What each band colour means: the sources that occur in the day, one swatch each. */
function FlowLegend({ spans }: { readonly spans: readonly EnergyFlowSpan[] }): ReactElement | null {
  const t = useUiText()
  const present = SOURCE_ORDER.filter((source) => spans.some((s) => s.source === source))
  if (present.length === 0) return null
  return (
    <ul
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-foreground-muted"
      data-testid="dc-energy-day-legend"
    >
      {present.map((source) => (
        <li key={source} className="flex items-center gap-1">
          <span
            className={cn('inline-block size-2 rounded-sm opacity-60', SOURCE_SWATCH[source])}
          />
          {sourceLabel(source, t)}
        </li>
      ))}
    </ul>
  )
}

function DayBar({
  dayStart,
  isToday,
  canNext,
  onPrev,
  onNext,
  onToday,
}: Pick<
  EnergyDayPanelProps,
  'dayStart' | 'isToday' | 'canNext' | 'onPrev' | 'onNext' | 'onToday'
>): ReactElement {
  const t = useUiText()
  return (
    <div className="flex items-center justify-center gap-1" data-testid="dc-energy-day-bar">
      <IconButton
        icon={ChevronLeft}
        variant="ghost"
        size="sm"
        aria-label={t('uiLibrary.deviceCard.energy.day.previous', 'Previous day')}
        onClick={onPrev}
      />
      <span
        className="min-w-28 text-center text-xs font-medium text-foreground tabular-nums"
        data-testid="dc-energy-day-label"
      >
        {isToday
          ? t('uiLibrary.deviceCard.energy.day.today', 'Today')
          : new Intl.DateTimeFormat(chartLocale(), DAY_FORMAT_OPTIONS).format(dayStart)}
      </span>
      <IconButton
        icon={ChevronRight}
        variant="ghost"
        size="sm"
        aria-label={t('uiLibrary.deviceCard.energy.day.next', 'Next day')}
        disabled={!canNext}
        onClick={onNext}
      />
      {isToday ? null : (
        <Button variant="ghost" size="sm" onClick={onToday}>
          {t('uiLibrary.deviceCard.energy.day.today', 'Today')}
        </Button>
      )}
    </div>
  )
}

/**
 * The selected day of an energy system: a previous / next / today bar over a
 * power chart on the day's clock (x axis in local time), the battery's charge
 * under it, and the spans where the house drew from or fed the grid or the
 * battery as bands. A day nothing recorded says so; a failed read says so.
 */
export function EnergyDayPanel(props: EnergyDayPanelProps): ReactElement {
  const t = useUiText()
  const bands = useMemo<readonly ChartBand[]>(
    () =>
      props.flowSpans.map((span, i) => ({
        id: `${span.source}-${String(i)}`,
        from: span.from,
        to: span.to,
        title: t('uiLibrary.deviceCard.energy.day.flow', 'Flow'),
        label: sourceLabel(span.source, t),
        tone: SOURCE_TONE[span.source],
      })),
    [props.flowSpans, t],
  )
  return (
    <div className="flex w-full flex-col gap-2" data-testid="dc-energy-day">
      <DayBar {...props} />
      {props.status === 'pending' ? <Skeleton className="h-32 w-full" /> : null}
      {props.status === 'empty' ? (
        <p
          className="py-6 text-center text-xs text-foreground-muted"
          data-testid="dc-energy-day-empty"
        >
          {t('uiLibrary.deviceCard.energy.day.empty', 'No data was recorded for this day.')}
        </p>
      ) : null}
      {props.status === 'error' ? (
        <p className="py-6 text-center text-xs text-danger" data-testid="dc-energy-day-error">
          {t('uiLibrary.deviceCard.energy.day.error', 'The history could not be read.')}
        </p>
      ) : null}
      {props.status === 'ready' ? (
        <>
          <TimeSeriesChart
            title={t('uiLibrary.deviceCard.energy.day.power', 'Power')}
            series={props.powerSeries}
            bands={bands}
            range={props.range}
            height={140}
            emptyMessage={t(
              'uiLibrary.deviceCard.energy.day.empty',
              'No data was recorded for this day.',
            )}
          />
          <FlowLegend spans={props.flowSpans} />
          {props.socSeries.length === 0 ? null : (
            <TimeSeriesChart
              title={t('uiLibrary.deviceCard.energy.day.charge', 'Battery charge')}
              series={props.socSeries}
              range={props.range}
              height={72}
            />
          )}
        </>
      ) : null}
    </div>
  )
}
