import { useMemo, type JSX } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { BarSeries } from '../charts/BarSeries'
import type { BarBucket, BarLayerDef } from '../charts/bar-series-model'
import type { DensityBucket, TimelineKind } from './recording-timeline-model'

interface EventHeatmapProps {
  readonly windowFrom: number
  readonly windowTo: number
  readonly buckets: readonly DensityBucket[]
  readonly selectedIndex: number | null
  readonly onSelectBucket: (index: number) => void
}

/** Stack order, bottom first; the categorical slots keep motion green, object violet, audio orange. */
const KINDS: readonly TimelineKind[] = ['motion', 'object', 'audio']
const KIND_SLOT: Readonly<Record<TimelineKind, number>> = { motion: 6, object: 5, audio: 4 }

/** A non-empty bucket is never thinner than this fraction of the strip. */
const MIN_BAR_FRACTION = 0.15

/**
 * Event-density strip under a recording timeline: one stacked bar per bucket
 * (motion / object / audio), height normalised to the busiest bucket, on the
 * timeline's own window. A click (or the bucket's button, for keyboard and
 * screen readers) selects the bucket — it drives the drill-down strip.
 */
export function EventHeatmap({
  windowFrom,
  windowTo,
  buckets,
  selectedIndex,
  onSelectBucket,
}: EventHeatmapProps): JSX.Element {
  const t = useUiText()
  const nonEmpty = useMemo(
    () => buckets.filter((b) => b.total > 0 && b.dominant !== null),
    [buckets],
  )
  const bars = useMemo<readonly BarBucket[]>(
    () => nonEmpty.map((b) => ({ t: b.startMs, values: KINDS.map((k) => b.counts[k]) })),
    [nonEmpty],
  )
  const layers = useMemo<readonly BarLayerDef[]>(
    () =>
      KINDS.map((k) => ({
        id: k,
        label: t(`uiLibrary.eventHeatmap.kind.${k}`, k),
        colorIndex: KIND_SLOT[k],
      })),
    [t],
  )
  const first = buckets[0]
  const bucketMs = first ? Math.max(1, first.endMs - first.startMs) : 1
  const selectedPos =
    selectedIndex === null ? null : nonEmpty.findIndex((b) => b.index === selectedIndex)

  return (
    <div className="rounded bg-background/40">
      <BarSeries
        compact
        title={t('uiLibrary.eventHeatmap.title', 'Event density')}
        layers={layers}
        buckets={bars}
        bucketMs={bucketMs}
        range={{ from: windowFrom, to: windowTo }}
        stacked
        minBarFraction={MIN_BAR_FRACTION}
        selectedIndex={selectedPos === null || selectedPos < 0 ? null : selectedPos}
        onSelect={(pos) => {
          const b = nonEmpty[pos]
          if (b) onSelectBucket(b.index)
        }}
        bucketTestId="heatmap-bar"
        bucketLabel={(_bar, pos) => {
          const b = nonEmpty[pos]
          if (!b) return ''
          return t(
            'uiLibrary.eventHeatmap.bucketTitle',
            '{{time}} · motion {{motion}} · object {{object}}',
            {
              time: new Date(b.startMs).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
              }),
              motion: b.counts.motion,
              object: b.counts.object,
            },
          )
        }}
      />
    </div>
  )
}
