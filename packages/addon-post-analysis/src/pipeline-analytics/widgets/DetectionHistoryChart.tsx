/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- React-Query inferred types collapse to 'error' under bundle parserService context (Phase D widget consolidation, lint-clean in original packages). Phase E builder migration revisits. */
/**
 * DetectionHistoryChart — object detection events from
 * `pipeline-analytics.getObjectEvents`, bucketed client-side and drawn as a
 * stacked `BarSeries` per class (D899). The top-N classes get their own layer;
 * everything else collapses into "other" so a camera with 20 raw classes still
 * fits in the legend.
 *
 * A class keeps its colour slot for as long as it is in the window: the slot
 * is its position in the SORTED class universe of the unfiltered fetch, never
 * its rank, so a filter or a busier hour does not repaint the others.
 *
 * Window presets: `1h / 6h / 24h`. Object-event retention is 30 days
 * server-side. The class filter is applied client-side — we always fetch the
 * unfiltered window, which keeps the dropdown's class universe stable.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { Eye } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { ObjectEvent } from '@camstack/types'
import {
  BarSeries,
  SectionCard,
  Select,
  useDeviceProxy,
  useSystem,
  type BarBucket,
  type BarLayerDef,
} from '@camstack/ui-library'
import { formatRangeLabel, humanBucket } from './chart-utils'
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
const TOP_N_CLASSES = 4
const OTHER_KEY = '__other__'
const ALL_CLASSES = '__all__'
const CHART_HEIGHT = 140

export interface DetectionHistoryChartProps {
  readonly deviceId: number
}

export function DetectionHistoryChart({ deviceId }: DetectionHistoryChartProps) {
  const { t } = useT()
  const headingId = useId()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const [windowPreset, setWindowPreset] = useState<WindowPreset>('1h')
  const [classFilter, setClassFilter] = useState<string>(ALL_CLASSES)
  const config = WINDOW_CONFIG[windowPreset]

  const query = useQuery<readonly ObjectEvent[]>({
    queryKey: ['pipeline-analytics', deviceId, 'objectEvents', windowPreset],
    queryFn: async () => {
      if (!dev) return []
      const since = Date.now() - config.windowMs
      const out = await dev.pipelineAnalytics?.getObjectEvents({
        since,
        limit: QUERY_LIMIT,
      })
      return out ?? []
    },
    enabled: !!dev,
    refetchInterval: config.pollIntervalMs,
    staleTime: Math.max(1_000, config.pollIntervalMs / 2),
  })

  const allEvents = query.data ?? []
  const events = useMemo(
    () =>
      classFilter === ALL_CLASSES
        ? allEvents
        : allEvents.filter((e) => e.className === classFilter),
    [allEvents, classFilter],
  )
  const axisTo = query.dataUpdatedAt > 0 ? query.dataUpdatedAt : Date.now()
  const axisFrom = axisTo - config.windowMs

  // The class universe of the UNFILTERED window, sorted: every class stays
  // selectable, and its index is its colour slot.
  const knownClasses = useMemo(() => {
    const set = new Set<string>()
    for (const e of allEvents) set.add(e.className)
    if (classFilter !== ALL_CLASSES) set.add(classFilter)
    return [...set].toSorted()
  }, [allEvents, classFilter])

  useEffect(() => {
    if (
      classFilter !== ALL_CLASSES &&
      allEvents.length > 0 &&
      !knownClasses.includes(classFilter)
    ) {
      setClassFilter(ALL_CLASSES)
    }
  }, [classFilter, allEvents, knownClasses])

  const stackOrder = useMemo(() => {
    const top = topNClasses(events, TOP_N_CLASSES)
    const ord = top.toSorted()
    if (events.some((e) => !top.includes(e.className))) ord.push(OTHER_KEY)
    return ord
  }, [events])

  const layers = useMemo<readonly BarLayerDef[]>(
    () =>
      stackOrder.map((key) => ({
        id: key,
        label: key === OTHER_KEY ? t('detectionHistory.other') : key,
        // "other" takes the slot after every real class, so it never steals one.
        colorIndex: key === OTHER_KEY ? knownClasses.length : knownClasses.indexOf(key),
      })),
    [stackOrder, knownClasses, t],
  )

  const buckets = useMemo<readonly BarBucket[]>(
    () => bucketize(events, axisFrom, axisTo, config.bucketMs, stackOrder),
    [events, axisFrom, axisTo, config.bucketMs, stackOrder],
  )
  const peak = buckets.reduce(
    (acc, b) =>
      Math.max(
        acc,
        b.values.reduce<number>((s, v) => s + (v ?? 0), 0),
      ),
    0,
  )
  const bucketText = humanBucket(config.bucketMs)

  const classOptions = useMemo(
    () => [
      { value: ALL_CLASSES, label: t('detectionHistory.allClasses') },
      ...knownClasses.map((c) => ({ value: c, label: c })),
    ],
    [knownClasses, t],
  )

  return (
    <SectionCard
      headingId={headingId}
      title={t('detectionHistory.title')}
      icon={Eye}
      actions={
        knownClasses.length > 0 ? (
          <div className="w-32">
            <Select
              value={classFilter}
              onChange={(ev) => setClassFilter(ev.target.value)}
              options={classOptions}
              aria-label={t('detectionHistory.filterByClass')}
            />
          </div>
        ) : undefined
      }
    >
      <div className="p-3 min-w-0">
        <BarSeries
          title={t('detectionHistory.barsTitle', { bucket: bucketText })}
          layers={layers}
          buckets={events.length === 0 ? [] : buckets}
          bucketMs={config.bucketMs}
          range={{ from: axisFrom, to: axisTo }}
          height={CHART_HEIGHT}
          stacked
          pending={query.isLoading}
          emptyMessage={t('detectionHistory.empty')}
          windowToggle={{
            options: PRESETS,
            value: windowPreset,
            onChange: (id) => {
              if (isPreset(id)) setWindowPreset(id)
            },
            ariaLabel: t('common.timeWindow'),
          }}
          bucketLabel={(b) =>
            `${formatRangeLabel(b.t, b.t + config.bucketMs)} · ${t('detectionHistory.detections', {
              count: b.values.reduce<number>((s, v) => s + (v ?? 0), 0),
            })}`
          }
          footer={
            events.length > 0 ? (
              <div className="flex items-center justify-between">
                <span>
                  {t('detectionHistory.summary', { count: events.length, bucket: bucketText })}
                </span>
                <span>{t('detectionHistory.peak', { value: peak })}</span>
              </div>
            ) : undefined
          }
        />
      </div>
    </SectionCard>
  )
}

/** The `n` most frequent classes of the window. */
function topNClasses(events: readonly ObjectEvent[], n: number): readonly string[] {
  const tally = new Map<string, number>()
  for (const e of events) tally.set(e.className, (tally.get(e.className) ?? 0) + 1)
  return [...tally.entries()]
    .toSorted(([, a], [, b]) => b - a)
    .slice(0, n)
    .map(([className]) => className)
}

/** One bucket per `bucketMs` over the window, one value per layer in `order`. */
function bucketize(
  events: readonly ObjectEvent[],
  from: number,
  to: number,
  bucketMs: number,
  order: readonly string[],
): readonly BarBucket[] {
  if (to <= from) return []
  const startBucket = Math.floor(from / bucketMs) * bucketMs
  const endBucket = Math.floor(to / bucketMs) * bucketMs
  const layerOf = new Map(order.map((k, i) => [k, i]))
  const otherIdx = layerOf.get(OTHER_KEY)
  const slots = new Map<number, number[]>()
  for (let b = startBucket; b <= endBucket; b += bucketMs)
    slots.set(
      b,
      order.map(() => 0),
    )
  for (const ev of events) {
    if (ev.timestamp < from || ev.timestamp > to) continue
    const row = slots.get(Math.floor(ev.timestamp / bucketMs) * bucketMs)
    const li = layerOf.get(ev.className) ?? otherIdx
    if (!row || li === undefined) continue
    row[li] = (row[li] ?? 0) + 1
  }
  return [...slots.entries()].toSorted(([a], [b]) => a - b).map(([t, values]) => ({ t, values }))
}
