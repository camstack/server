/**
 * Per-camera load — CPU and memory, drawn from what the addons report about
 * themselves.
 *
 * One card per camera, two charts on it, and one badge for the part of the
 * node nothing accounts for. That is the whole surface.
 *
 * ## What was deleted on 2026-08-28, and what it cost to keep
 *
 * This panel used to carry five paragraphs: how contributions are collected,
 * why CPU is a delta, when the window started, how many processes the addons
 * claim, a shared-cost section and a list of every family the chart refuses
 * with its reason. The operator's verdict was that none of it carried
 * information he could act on.
 *
 * The classification did NOT go with the prose. `camera-load-attribution.ts`
 * is still the gate — `camera-load-rates.ts` derives `chartableCameraRoles()`
 * from it and `isChartableContribution` refuses everything else — so an
 * apportioned estimate still cannot be drawn as a measurement. What was
 * deleted is the RENDERING of that reasoning, not the reasoning. (D249.)
 *
 * One measurement survived the paragraph that carried it: the processes on
 * this node that no contribution claims, and the bytes they hold. Fifteen
 * gigabytes held by processes nothing accounts for is either a leak or a cost
 * family nobody has taught to report, and deleting the text would have deleted
 * the only surface that says so. It is a badge now — a count and a size — with
 * the sentence gone and the number kept.
 *
 * ## The window is on the axis now
 *
 * "Differencing since 14:32:49 (11 windows)" was one of the deleted sentences,
 * and the charts had no x axis to replace it. They do now, so the window is
 * visible per chart and positioned rather than narrated. That made `gapMs`
 * load-bearing here: these charts were passing none, so `projectSeries` placed
 * every sample at its true time while `toLinePath` joined straight across a
 * hole. The axis would have labelled a forty-minute outage correctly and the
 * line would have drawn through it as if measured.
 */
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { useDeviceManagerListAll } from '@camstack/ui-library'
import { formatBytes } from '../../../lib/format-size'
import { SingleLineChart } from './LoadChart'
import { gapThresholdMs } from '@camstack/ui-library'
import { type NodeScope } from './contribution-origin'
import { useCameraLoadSeries } from './use-camera-load-series'
import { cameraNamesById } from './camera-names'
import type { CameraLoadBucket } from './camera-load-fold'

/** 25% of one core — below it a camera's CPU line is noise, not a trend. */
const CPU_AXIS_FLOOR_PERCENT = 25
/** 64 MiB — a single ffmpeg child idles well under a runner's 256 MiB floor. */
const MEMORY_AXIS_FLOOR_BYTES = 64 * 1024 * 1024

/** The shipped snapshot cadence, used only until the server states its own. */
const FALLBACK_CADENCE_MS = 10_000

interface CameraLoadPanelProps {
  readonly scope: NodeScope
  /**
   * The node's process-snapshot cadence, which is the beat this panel's
   * readings ride. NOT the per-addon `bucketMs`: that describes a reduced
   * retained series, and these points are raw.
   */
  readonly cadenceMs: number | null
}

export function CameraLoadPanel({ scope, cadenceMs }: CameraLoadPanelProps) {
  const { t } = useTranslation()
  const state = useCameraLoadSeries(scope)
  // Same key and input shape the detection-intelligence sections use, so this
  // is served from the fleet window the query client already registered rather
  // than opening a second fetch. No `staleTime` here on purpose (D274).
  const { data: devices = [] } = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const names = cameraNamesById(devices)
  // Without this every chart below joins straight across an outage. The x axis
  // places the samples by real time, so the hole already has a WIDTH — leaving
  // the line unbroken would draw the most confident segment on the card across
  // the one interval nobody measured.
  const gapMs = gapThresholdMs(cadenceMs ?? FALLBACK_CADENCE_MS)

  return (
    <section className="space-y-3">
      {state.error !== null && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            {t(
              'cameraLoad.readFailed',
              'Could not read the load contributions: {{error}}. This is a failed read, NOT an idle cluster.',
              { error: state.error },
            )}
          </span>
        </div>
      )}

      <UnclaimedBadge unclaimed={state.unclaimed} />

      {state.series.length === 0 && state.error === null && (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[11px] text-foreground-subtle">
          {state.loading
            ? t('cameraLoad.loading', 'Reading what the addons report…')
            : t('cameraLoad.waitingWindow', 'No per-camera window yet.')}
        </div>
      )}

      <div className="space-y-3">
        {state.series.map((camera) => (
          <div key={camera.deviceId} className="rounded-lg border border-border p-3">
            <div className="flex items-baseline justify-between gap-2 mb-2">
              <CameraTitle deviceId={camera.deviceId} name={names.get(camera.deviceId)} />
              <span className="text-[10px] text-foreground-subtle">
                {t('cameraLoad.unitCount', '{{count}} unit(s): {{roles}}', {
                  count: camera.points.at(-1)?.unitCount ?? 0,
                  roles: (camera.points.at(-1)?.roles ?? []).join(', '),
                })}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <SingleLineChart
                title={t('cameraLoad.cpuTitle', 'CPU % of one core (delta)')}
                points={camera.points.map((p) => ({ atMs: p.atMs, value: p.cpuPercent }))}
                formatValue={(v) => `${v.toFixed(1)}%`}
                axisFloor={CPU_AXIS_FLOOR_PERCENT}
                gapMs={gapMs}
                emptyMessage={t('cameraLoad.cpuUnavailable', 'No measurable window yet.')}
              />
              <SingleLineChart
                title={t('cameraLoad.memoryTitle', 'Memory RSS')}
                points={camera.points.map((p) => ({ atMs: p.atMs, value: p.rssBytes }))}
                formatValue={formatBytes}
                axisFloor={MEMORY_AXIS_FLOOR_BYTES}
                // `formatBytes` is binary — a decimally-rounded axis top
                // prints as `4.7 GB`, a number that is an artefact of two
                // number systems meeting rather than a measurement of
                // anything. The per-addon charts above already pass this.
                axisScale="bytes"
                gapMs={gapMs}
                emptyMessage={t('cameraLoad.memoryUnavailable', 'No memory reported.')}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * The camera's own name, with its id kept reachable.
 *
 * The name is the heading because the operator has thirty cameras and knows
 * them as "Parking pat", not as 1441. The id stays beside it, subdued,
 * because every log line in this system is tagged by numeric `deviceId` and a
 * card that dropped it could not be matched against one.
 *
 * A camera with no name — or one that has left the fleet since it last
 * reported a cost — falls back to `Camera <id>` and shows no suffix: repeating
 * the id twice on one line is noise.
 */
function CameraTitle({
  deviceId,
  name,
}: {
  readonly deviceId: number
  readonly name: string | undefined
}) {
  const { t } = useTranslation()
  if (name === undefined) {
    return (
      <span className="text-xs font-medium text-foreground">
        {t('cameraLoad.deviceLabel', 'Camera {{deviceId}}', { deviceId })}
      </span>
    )
  }
  return (
    <span className="flex items-baseline gap-1.5 min-w-0">
      <span className="text-xs font-medium text-foreground truncate">{name}</span>
      <span className="shrink-0 text-[10px] font-mono text-foreground-subtle">#{deviceId}</span>
    </span>
  )
}

/**
 * Processes this node runs that no contribution claims, and the memory they
 * hold — as a count and a size, in the page's badge idiom.
 *
 * The number is the finding: a camstack-shaped process nobody claims is either
 * a leak or a cost family nobody has taught to report. It used to arrive
 * wrapped in a paragraph that said exactly that, and the paragraph was
 * rejected; the measurement is what an operator can act on, so the
 * measurement is what stayed.
 *
 * Absent when nothing is unclaimed, and absent when no process snapshot has
 * arrived — a badge is a positive finding, and "we did not look" has no
 * number to show.
 */
function UnclaimedBadge({ unclaimed }: { readonly unclaimed: CameraLoadBucket | null }) {
  const { t } = useTranslation()
  if (unclaimed === null || unclaimed.unitCount === 0) return null
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning/10 text-warning font-medium tabular-nums">
        {t('cameraLoad.unclaimedBadge', '{{count}} unclaimed · {{rss}}', {
          count: unclaimed.unitCount,
          rss: unclaimed.rssBytes === null ? '—' : formatBytes(unclaimed.rssBytes),
        })}
      </span>
    </div>
  )
}
