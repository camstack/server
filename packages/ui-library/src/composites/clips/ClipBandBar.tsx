/**
 * The clips section's timebar — the recording section's own controls, driving
 * a clip list instead of a player (D564).
 *
 * *"Possiamo utilizzare lo stesso componente della sezione recording con la
 * timebar dove selezionare un periodo e mostrare le clip solo di quella banda
 * selezionata, espandibile."* [We can use the same component as the recording section with the timebar where a period can be selected and show the clips of that selected band only, expandable.] — the operator, 2026-09-20. So this is not a
 * second timebar: it is `TimelineControls` and `EventHeatmap`, the two pieces
 * `RecordingTimeline` is itself built from, over the same
 * `recording-timeline-model` (`dayWindow`, `panWindow`,
 * `zoomWindowAnchoredRight`, `bucketMsForSpan`, `axisTicks`). One
 * implementation, one model, two surfaces.
 *
 * ## What it does NOT take from the recording timeline
 *
 * `CoverageTrack` stays behind. There it is the seek surface — a click drives
 * the hero player through the `camstack-control` channel or an HLS VOD
 * request. A copy here would either be a dead bar or a SECOND thing claiming
 * to move the playhead, and two components holding two ideas of the same
 * position is the defect this repo keeps paying for. The clips section plays a
 * clip through `ClipPanel`, which is its own, already-shipped path.
 *
 * ## This component is presentational
 *
 * It holds no state. The day, the visible window and the picked bucket all
 * live in `ClipsSection`, because that is where the band is turned into the
 * `listClips` argument — a bar that kept its own copy of the selection would
 * be the second authority again, one component down.
 */
import { useCallback, useRef, type WheelEvent, type JSX } from 'react'

import {
  axisTicks,
  panWindow,
  type DayWindow,
  type DensityBucket,
} from '../cap-settings/recording-timeline-model.js'
import { EventHeatmap } from '../cap-settings/EventHeatmap.js'
import { TimelineControls } from '../cap-settings/TimelineControls.js'
import { useUiText } from '../../contexts/ui-text.js'

/**
 * How many ms one pixel of horizontal wheel delta pans.
 *
 * The same calibration `RecordingTimeline` uses — a standard wheel tick
 * (~100 px of `deltaX`) pans ~30 min. Two timebars that panned at different
 * rates would read as two different controls.
 */
const PAN_MS_PER_PX = 18_000 / 100

export interface ClipBandBarProps {
  /** The calendar day the window is inside. */
  readonly day: Date
  readonly onDayChange: (day: Date) => void
  /** The visible window — the band, whenever no bucket is picked. */
  readonly view: DayWindow
  /** The full day, the clamp for every zoom and pan. */
  readonly dayBounds: DayWindow
  readonly onViewChange: (view: DayWindow) => void
  readonly buckets: readonly DensityBucket[]
  readonly selectedBucketIndex: number | null
  readonly onSelectBucket: (index: number) => void
  readonly densityLoading: boolean
}

export function ClipBandBar({
  day,
  onDayChange,
  view,
  dayBounds,
  onViewChange,
  buckets,
  selectedBucketIndex,
  onSelectBucket,
  densityLoading,
}: ClipBandBarProps): JSX.Element {
  const t = useUiText()
  const trackAreaRef = useRef<HTMLDivElement>(null)

  const handleWheel = useCallback(
    (e: WheelEvent<HTMLDivElement>): void => {
      const deltaX = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
      if (deltaX === 0) return
      e.preventDefault()
      onViewChange(panWindow(view, dayBounds, deltaX * PAN_MS_PER_PX))
    },
    [view, dayBounds, onViewChange],
  )

  const ticks = axisTicks(view.fromMs, view.toMs, 5)

  return (
    <div className="space-y-1">
      <TimelineControls
        day={day}
        onDayChange={onDayChange}
        view={view}
        dayBounds={dayBounds}
        onViewChange={onViewChange}
      />

      <div ref={trackAreaRef} onWheel={handleWheel} className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
          {t('uiLibrary.clipBandBar.eventsDensity', 'Events · density')}
        </div>
        {densityLoading ? (
          <div className="h-6 animate-pulse rounded bg-background/40" />
        ) : (
          <EventHeatmap
            windowFrom={view.fromMs}
            windowTo={view.toMs}
            buckets={buckets}
            selectedIndex={selectedBucketIndex}
            onSelectBucket={onSelectBucket}
          />
        )}

        <div className="relative h-3">
          {ticks.map((tick) => (
            <span
              key={tick.pct}
              className="absolute -translate-x-1/2 text-[9px] text-foreground-subtle"
              style={{ left: `${String(tick.pct)}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
