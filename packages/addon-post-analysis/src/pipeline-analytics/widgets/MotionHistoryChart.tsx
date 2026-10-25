/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- React-Query inferred types collapse to 'error' under bundle parserService context (Phase D widget consolidation, lint-clean in original packages). Phase E builder migration revisits. */
/**
 * MotionHistoryChart — motion events from `pipeline-analytics.getMotionEvents`,
 * bucketed client-side and drawn by the library `BarSeries` (D899). The SQL
 * store keeps motion rows for ~14 days, so the longer presets are meaningful.
 *
 * Window presets: `1h / 6h / 24h`. The cap returns up to 5000 events per
 * query; we ask for the maximum so a chatty camera does not lose old buckets
 * to truncation. Every bucket of the window is present (a quiet one is `0`):
 * the events query answered, so an empty bucket is a measured zero.
 */
import { useId, useMemo, useState } from 'react'
import { Activity } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { MotionEvent } from '@camstack/types'
import {
  BarSeries,
  SectionCard,
  useDeviceProxy,
  useSystem,
  type BarBucket,
  type BarLayerDef,
} from '@camstack/ui-library'
import { bucketCounts, formatRangeLabel, humanBucket } from './chart-utils'
import { useT } from '../../i18n/index.js'

type WindowPreset = '1h' | '6h' | '24h'

interface WindowSpec {
  readonly label: string
  readonly windowMs: number
  readonly bucketMs: number
  readonly pollIntervalMs: number
}

const WINDOW_CONFIG: Record<WindowPreset, WindowSpec> = {
  '1h': { label: '1 h', windowMs: 60 * 60_000, bucketMs: 60_000, pollIntervalMs: 15_000 },
  '6h': { label: '6 h', windowMs: 6 * 60 * 60_000, bucketMs: 5 * 60_000, pollIntervalMs: 60_000 },
  '24h': {
    label: '24 h',
    windowMs: 24 * 60 * 60_000,
    bucketMs: 15 * 60_000,
    pollIntervalMs: 300_000,
  },
}

const PRESETS = [
  { id: '1h' as const, label: WINDOW_CONFIG['1h'].label },
  { id: '6h' as const, label: WINDOW_CONFIG['6h'].label },
  { id: '24h' as const, label: WINDOW_CONFIG['24h'].label },
]

const isPreset = (id: string): id is WindowPreset => id in WINDOW_CONFIG

const QUERY_LIMIT = 5000
const CHART_HEIGHT = 120

export interface MotionHistoryChartProps {
  readonly deviceId: number
}

export function MotionHistoryChart({ deviceId }: MotionHistoryChartProps) {
  const { t } = useT()
  const headingId = useId()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const [windowPreset, setWindowPreset] = useState<WindowPreset>('1h')
  const config = WINDOW_CONFIG[windowPreset]

  const query = useQuery<readonly MotionEvent[]>({
    queryKey: ['pipeline-analytics', deviceId, 'motionEvents', windowPreset],
    queryFn: async () => {
      if (!dev) return []
      const since = Date.now() - config.windowMs
      const out = await dev.pipelineAnalytics?.getMotionEvents({
        since,
        limit: QUERY_LIMIT,
      })
      return out ?? []
    },
    enabled: !!dev,
    refetchInterval: config.pollIntervalMs,
    staleTime: Math.max(1_000, config.pollIntervalMs / 2),
  })

  const events = query.data ?? []
  // Anchor the x axis on the last fetch so bars line up with the queried range.
  const axisTo = query.dataUpdatedAt > 0 ? query.dataUpdatedAt : Date.now()
  const axisFrom = axisTo - config.windowMs

  const buckets = useMemo<readonly BarBucket[]>(
    () =>
      bucketCounts(
        events.map((e) => e.timestamp),
        axisFrom,
        axisTo,
        config.bucketMs,
      ).map((b) => ({ t: b.bucketStart, values: [b.count] })),
    [events, axisFrom, axisTo, config.bucketMs],
  )
  const layers = useMemo<readonly BarLayerDef[]>(
    () => [{ id: 'motion', label: t('motionHistory.title'), colorIndex: 0 }],
    [t],
  )
  const peak = buckets.reduce((acc, b) => Math.max(acc, b.values[0] ?? 0), 0)
  const totalEvents = events.length
  const bucketText = humanBucket(config.bucketMs)

  return (
    <SectionCard headingId={headingId} title={t('motionHistory.title')} icon={Activity}>
      <div className="p-3 min-w-0">
        <BarSeries
          title={t('motionHistory.barsTitle', { bucket: bucketText })}
          layers={layers}
          buckets={totalEvents === 0 ? [] : buckets}
          bucketMs={config.bucketMs}
          range={{ from: axisFrom, to: axisTo }}
          height={CHART_HEIGHT}
          pending={query.isLoading}
          emptyMessage={t('motionHistory.empty')}
          windowToggle={{
            options: PRESETS,
            value: windowPreset,
            onChange: (id) => {
              if (isPreset(id)) setWindowPreset(id)
            },
            ariaLabel: t('common.timeWindow'),
          }}
          bucketLabel={(b) =>
            `${formatRangeLabel(b.t, b.t + config.bucketMs)} · ${t('motionHistory.events', { count: b.values[0] ?? 0 })}`
          }
          footer={
            totalEvents > 0 ? (
              <div className="flex items-center justify-between">
                <span>
                  {t('motionHistory.summary', { count: totalEvents, bucket: bucketText })}
                </span>
                <span>{t('motionHistory.peak', { value: peak })}</span>
              </div>
            ) : undefined
          }
        />
      </div>
    </SectionCard>
  )
}
