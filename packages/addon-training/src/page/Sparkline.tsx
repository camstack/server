/**
 * A job's mAP50 per epoch: the library `Sparkline` beside its latest value.
 * Colour is the `primary` token.
 */
import { useMemo } from 'react'
import type { TrainingProgressPoint } from '@camstack/types'
import { Sparkline as ChartSparkline, type SparklinePoint } from '@camstack/ui-library'
import { useT } from '../i18n/index.js'

export interface SparklineProps {
  readonly series: readonly TrainingProgressPoint[]
}

export function Sparkline({ series }: SparklineProps) {
  const { t } = useT()
  const points = useMemo<readonly SparklinePoint[]>(
    () => series.map((p) => ({ x: p.epoch, v: p.map50 })),
    [series],
  )
  const known = series.filter((p) => p.map50 !== null)
  if (known.length < 2)
    return <span className="text-xs text-foreground-subtle">{t('sparkline.afterTwoEpochs')}</span>
  const last = known.at(-1)?.map50 ?? 0
  return (
    <span className="inline-flex items-center gap-2" data-testid="map-sparkline">
      <ChartSparkline points={points} ariaLabel={t('sparkline.perEpoch')} token="primary" />
      <span className="text-xs text-foreground">mAP50 {last.toFixed(3)}</span>
    </span>
  )
}
