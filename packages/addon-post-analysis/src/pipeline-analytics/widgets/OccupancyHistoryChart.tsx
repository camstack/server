/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- React-Query inferred types collapse to 'error' under bundle parserService context (Phase D widget consolidation, lint-clean in original packages). Phase E builder migration revisits. */
/**
 * OccupancyHistoryChart — a `TimeSeriesChart` (D899) over the LONG-TERM series
 * (`pipelineAnalytics.readLongTermSeries`, series `occupancy`).
 *
 * ## Why it no longer reads `zone-analytics.getCameraHistory`
 *
 * That call is served from a 60-MINUTE in-memory ring. It dies with the
 * process, so after a restart the chart is empty about a night that did
 * happen, and any window past an hour silently clamped — the preset list had
 * to be trimmed to `5m / 30m / 1h` to hide a horizon rather than to serve a
 * question. Nobody asks "how busy was the driveway in the last five minutes";
 * they ask about last night.
 *
 * The long-term rows were already being written for every camera, at ~60 bytes
 * per (camera, series, scope, 5-minute bucket), kept for a year. Nothing read
 * them. This chart is the first reader.
 *
 * ## What changed for the operator
 *
 * The buckets are five minutes wide, which is the floor: a sub-hour preset
 * would draw one or two columns and read as a fault. Presets are therefore
 * `1h / 6h / 24h / 7d`, and the shortest of them holds twelve buckets.
 *
 * The class filter is now a SCOPE, not a server-side count filter:
 * `occupancyScope(undefined, className)` selects the per-class series the
 * provider writes beside the aggregate. `<all classes>` reads the aggregate
 * scope `''`, whose meaning is unchanged from before the class dimension
 * existed.
 *
 * ## A bucket that is absent was not measured
 *
 * The series is sparse by design — a camera that saw nothing writes nothing,
 * which is a different claim from "it saw zero". The chart plots the buckets
 * that exist and does not interpolate a floor through the gaps, because a flat
 * zero line through a camera that was offline is a lie that looks like data.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { Layers } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { HistoryPoint } from '@camstack/types'
import { occupancyScope } from '@camstack/types'
import {
  SectionCard,
  Select,
  TimeSeriesChart,
  gapThresholdMs,
  useDeviceProxy,
  useDeviceStateSlice,
  useSystem,
  type TimeSeriesDef,
} from '@camstack/ui-library'
import { useT } from '../../i18n/index.js'

type WindowPreset = '1h' | '6h' | '24h' | '7d'

interface WindowSpec {
  readonly label: string
  readonly windowMs: number
  readonly pollIntervalMs: number
}

/** The long-term bucket width. Every window is a multiple of it, and it is why
 *  the sub-hour presets are gone: a 5-minute window is ONE bucket. */
const LTS_BUCKET_MS = 5 * 60_000

const WINDOW_CONFIG: Record<WindowPreset, WindowSpec> = {
  '1h': { label: '1 h', windowMs: 60 * 60_000, pollIntervalMs: 30_000 },
  '6h': { label: '6 h', windowMs: 6 * 60 * 60_000, pollIntervalMs: 60_000 },
  '24h': { label: '24 h', windowMs: 24 * 60 * 60_000, pollIntervalMs: 120_000 },
  // A week is 2 016 buckets — the row cap is 105 120 per scope, so the series
  // holds a year and this preset is nowhere near it.
  '7d': { label: '7 d', windowMs: 7 * 24 * 60 * 60_000, pollIntervalMs: 300_000 },
}

const PRESETS = [
  { id: '1h' as const, label: WINDOW_CONFIG['1h'].label },
  { id: '6h' as const, label: WINDOW_CONFIG['6h'].label },
  { id: '24h' as const, label: WINDOW_CONFIG['24h'].label },
  { id: '7d' as const, label: WINDOW_CONFIG['7d'].label },
]

const isPreset = (id: string): id is WindowPreset => id in WINDOW_CONFIG

const CHART_HEIGHT = 120

const ALL_CLASSES = '__all__'

export interface OccupancyHistoryChartProps {
  readonly deviceId: number
}

export function OccupancyHistoryChart({ deviceId }: OccupancyHistoryChartProps) {
  const { t } = useT()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const [windowPreset, setWindowPreset] = useState<WindowPreset>('24h')
  const [classFilter, setClassFilter] = useState<string>(ALL_CLASSES)
  const config = WINDOW_CONFIG[windowPreset]

  const headingId = useId()

  // Live snapshot drives the class-filter dropdown so it reflects the
  // classes actually present right now (operator-friendly: don't show
  // classes the camera never reports).
  const liveSnapshot = useDeviceStateSlice(dev?.state.zoneAnalytics)
  const availableClasses = useMemo(() => {
    const set = new Set<string>()
    if (liveSnapshot?.frame.byClass) {
      for (const k of Object.keys(liveSnapshot.frame.byClass)) set.add(k)
    }
    if (liveSnapshot?.zones) {
      for (const z of liveSnapshot.zones) {
        for (const k of Object.keys(z.byClass)) set.add(k)
      }
    }
    return [...set].toSorted()
  }, [liveSnapshot])

  // Reset class filter if the previously-selected class drops off.
  // Without this the dropdown silently shows an outdated label.
  useEffect(() => {
    if (classFilter !== ALL_CLASSES && !availableClasses.includes(classFilter)) {
      setClassFilter(ALL_CLASSES)
    }
  }, [classFilter, availableClasses])

  // Bucket window re-anchors to "now" on every refetch. Computing it
  // inside `queryFn` (instead of memoising at render time) avoids the
  // closure-staleness bug where the same fixed [from..to] would be
  // re-queried forever.
  const query = useQuery<readonly HistoryPoint[]>({
    queryKey: ['pipeline-analytics', deviceId, 'occupancyLts', windowPreset, classFilter],
    queryFn: async () => {
      if (!dev) return []
      const now = Date.now()
      // `from` is snapped DOWN to a bucket boundary: the store's bounds are
      // inclusive on the bucket START, so an unsnapped `from` drops the bucket
      // the window opens inside and the chart loses its oldest column.
      const from = Math.floor((now - config.windowMs) / LTS_BUCKET_MS) * LTS_BUCKET_MS
      const rows = await dev.pipelineAnalytics?.readLongTermSeries({
        series: 'occupancy',
        scope:
          classFilter === ALL_CLASSES ? occupancyScope() : occupancyScope(undefined, classFilter),
        from,
        to: now,
      })
      // `max` and not `sum`: a bucket folds many frames, and what the operator
      // reads off an occupancy chart is "how many were here", not "how many
      // sightings were added up". `sum` would scale with the frame rate.
      return (rows ?? []).map((r) => ({ ts: r.bucketStart, count: r.max }))
    },
    enabled: !!dev,
    refetchInterval: config.pollIntervalMs,
    staleTime: Math.max(1_000, config.pollIntervalMs / 2),
  })

  const points = query.data ?? []
  // The axis spans the rolling window anchored at the latest fetch.
  const axisTo = query.dataUpdatedAt > 0 ? query.dataUpdatedAt : Date.now()
  const axisFrom = axisTo - config.windowMs

  const series = useMemo<readonly TimeSeriesDef[]>(
    () => [
      {
        id: classFilter,
        label: classFilter === ALL_CLASSES ? t('occupancyHistory.allClasses') : classFilter,
        unit: null,
        colorIndex: 0,
        // A held count between buckets, and a bucket that is absent was not
        // measured: more than 2.5 buckets without a row is a hole, not a zero.
        interpolation: 'step',
        gapMs: gapThresholdMs(LTS_BUCKET_MS),
        points: points.map((p) => ({ t: p.ts, v: p.count })),
      },
    ],
    [points, classFilter, t],
  )
  const classOptions = useMemo(
    () => [
      { value: ALL_CLASSES, label: t('occupancyHistory.allClasses') },
      ...availableClasses.map((c) => ({ value: c, label: c })),
    ],
    [availableClasses, t],
  )

  return (
    <SectionCard
      headingId={headingId}
      title={t('occupancyHistory.title')}
      icon={Layers}
      actions={
        availableClasses.length > 0 ? (
          <div className="w-32">
            <Select
              value={classFilter}
              onChange={(ev) => setClassFilter(ev.target.value)}
              options={classOptions}
              aria-label={t('occupancyHistory.filterByClass')}
            />
          </div>
        ) : undefined
      }
    >
      <div className="p-3 min-w-0">
        <TimeSeriesChart
          title={t('occupancyHistory.lineTitle')}
          series={points.length === 0 ? [] : series}
          range={{ from: axisFrom, to: axisTo }}
          height={CHART_HEIGHT}
          pending={query.isLoading}
          emptyMessage={t('occupancyHistory.empty')}
          formatValue={(v) => String(Math.round(v))}
          windowToggle={{
            options: PRESETS,
            value: windowPreset,
            onChange: (id) => {
              if (isPreset(id)) setWindowPreset(id)
            },
            ariaLabel: t('common.timeWindow'),
          }}
          footer={
            points.length > 0 ? (
              <div className="flex items-center justify-between">
                <span>{t('occupancyHistory.buckets', { count: points.length })}</span>
                <span>
                  {t('occupancyHistory.peak', {
                    value: points.reduce((acc, p) => Math.max(acc, p.count), 0),
                  })}
                </span>
              </div>
            ) : undefined
          }
        />
      </div>
    </SectionCard>
  )
}
