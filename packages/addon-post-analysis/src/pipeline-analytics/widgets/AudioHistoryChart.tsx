/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- React-Query inferred types collapse to 'error' under bundle parserService context (Phase D widget consolidation, lint-clean in original packages). Phase E builder migration revisits. */
/**
 * AudioHistoryChart — audio dBFS over a window, from `audio-metrics.getHistory`
 * via the DeviceProxy, drawn by the library `TimeSeriesChart` (D899).
 *
 * Three presets (5 min / 1 h / 24 h); the polling cadence adapts (5 s, 30 s,
 * 5 min). `getHistory`'s server-side bucket-averaging keeps the payload
 * bounded whatever the window.
 *
 * The value axis floats around the data (a dBFS level lives far from zero):
 * operators read relative shape — silence floor against peaks — and a hard
 * `[-80..0]` wasted most of the plot on a quiet room.
 *
 * Two series: the instantaneous level and the window peak. A sample the
 * meter did not take (`dbfs: null`) breaks the line, and a hole longer than
 * 2.5 sample spacings is shaded. Class hits are counted under the chart.
 */
import { useId, useMemo, useState } from 'react'
import { Activity } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { AudioMetricsHistory } from '@camstack/types'
import {
  SectionCard,
  TimeSeriesChart,
  gapThresholdMs,
  useDeviceProxy,
  useSystem,
  type TimeSeriesDef,
} from '@camstack/ui-library'
import { useT } from '../../i18n/index.js'

type WindowPreset = '5m' | '1h' | '24h'

const WINDOW_CONFIG: Record<
  WindowPreset,
  {
    readonly label: string
    readonly windowSec: number
    readonly sampleEveryMs: number
    readonly pollIntervalMs: number
  }
> = {
  '5m': { label: '5 min', windowSec: 5 * 60, sampleEveryMs: 1_000, pollIntervalMs: 5_000 },
  '1h': { label: '1 h', windowSec: 60 * 60, sampleEveryMs: 5_000, pollIntervalMs: 30_000 },
  '24h': { label: '24 h', windowSec: 24 * 60 * 60, sampleEveryMs: 60_000, pollIntervalMs: 300_000 },
}

const PRESETS = [
  { id: '5m' as const, label: WINDOW_CONFIG['5m'].label },
  { id: '1h' as const, label: WINDOW_CONFIG['1h'].label },
  { id: '24h' as const, label: WINDOW_CONFIG['24h'].label },
]

const isPreset = (id: string): id is WindowPreset => id in WINDOW_CONFIG

const CHART_HEIGHT = 120
const DBFS = 'dBFS'

export interface AudioHistoryChartProps {
  readonly deviceId: number
}

export function AudioHistoryChart({ deviceId }: AudioHistoryChartProps) {
  const { t } = useT()
  const headingId = useId()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const [windowPreset, setWindowPreset] = useState<WindowPreset>('5m')
  const config = WINDOW_CONFIG[windowPreset]

  const query = useQuery<AudioMetricsHistory | null>({
    queryKey: ['audio-metrics', deviceId, 'history', windowPreset],
    queryFn: async () => {
      if (!dev) return null
      const out = await dev.audioMetrics?.getHistory({
        windowSec: config.windowSec,
        sampleEveryMs: config.sampleEveryMs,
      })
      return out ?? null
    },
    enabled: !!dev,
    refetchInterval: config.pollIntervalMs,
    staleTime: Math.max(1_000, config.pollIntervalMs / 2),
  })

  const history = query.data
  const points = useMemo(() => history?.points ?? [], [history])
  const spacingMs = history?.effectiveSampleEveryMs ?? config.sampleEveryMs
  const axisTo = query.dataUpdatedAt > 0 ? query.dataUpdatedAt : Date.now()
  const axisFrom = axisTo - config.windowSec * 1000

  const series = useMemo<readonly TimeSeriesDef[]>(() => {
    const gapMs = gapThresholdMs(spacingMs)
    return [
      {
        id: 'level',
        label: t('audioHistory.level'),
        unit: DBFS,
        colorIndex: 0,
        gapMs,
        points: points.map((p) => ({ t: p.ts, v: p.dbfs })),
      },
      {
        id: 'peak',
        label: t('audioHistory.peakWindow'),
        unit: DBFS,
        colorIndex: 1,
        gapMs,
        points: points.map((p) => ({ t: p.ts, v: p.peakDbfs })),
      },
    ]
  }, [points, spacingMs, t])

  // Class hits, counted per class over the window (the dots of the old chart).
  const classHits = useMemo(() => {
    const tally = new Map<string, number>()
    for (const p of points)
      if (p.topClass !== null) tally.set(p.topClass, (tally.get(p.topClass) ?? 0) + 1)
    return [...tally.entries()].toSorted(([, a], [, b]) => b - a)
  }, [points])
  const peak = points.reduce((acc, p) => Math.max(acc, p.peakDbfs), Number.NEGATIVE_INFINITY)

  return (
    <SectionCard headingId={headingId} title={t('audioHistory.title')} icon={Activity}>
      <div className="p-3 min-w-0">
        <TimeSeriesChart
          title={t('audioHistory.lineTitle')}
          series={points.length === 0 ? [] : series}
          range={{ from: axisFrom, to: axisTo }}
          height={CHART_HEIGHT}
          pending={query.isLoading}
          emptyMessage={t('audioHistory.empty')}
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
              <div className="space-y-0.5">
                <div className="flex items-center justify-between">
                  <span>
                    {t('audioHistory.samples', {
                      count: points.length,
                      seconds: Math.round(spacingMs / 1000),
                    })}
                  </span>
                  <span>{t('audioHistory.peak', { value: peak.toFixed(1) })}</span>
                </div>
                {classHits.length > 0 && (
                  <div>
                    {t('audioHistory.classHits', {
                      list: classHits.map(([name, n]) => `${name} ×${String(n)}`).join(', '),
                    })}
                  </div>
                )}
              </div>
            ) : undefined
          }
        />
      </div>
    </SectionCard>
  )
}
