/**
 * The camera's Live Stats tab: the analytics widgets the hub lists
 * (`addonWidgets.listWidgets`) and invented events behind the detection
 * histogram and the live cards. Deterministic against the fixed clock.
 */
import { MINUTE, NOW } from './_time'

const REMOTE = { remoteName: 'addon_pipeline_analytics_widgets', exposedModule: './widgets' }

const widget = (stableId: string, label: string) => ({
  tab: 'device-tab',
  label,
  kind: 'remote',
  remote: { ...REMOTE, componentKey: stableId },
  preAuth: false,
  stableId,
  description: label,
  icon: 'activity',
  bundle: 'remoteEntry.js',
  hosts: ['device-tab', 'dashboard'],
  requires: { deviceContext: true, integrationContext: false },
  defaultSize: 'lg',
  allowedSizes: ['md', 'lg', 'xl'],
  defaultColumns: 12,
  defaultRows: 2,
  addonId: 'pipeline-analytics',
  bundleUrl: '/api/addon-widgets/pipeline-analytics/remoteEntry.js',
})

export const ANALYTICS_WIDGETS = [
  widget('live-stats', 'Live Stats'),
  widget('live-occupancy-panel', 'Live Occupancy'),
  widget('audio-metrics-panel', 'Audio Metrics'),
  widget('audio-history-chart', 'Audio Level History'),
  widget('occupancy-history-chart', 'Occupancy History'),
  widget('motion-history-chart', 'Motion History'),
  widget('detection-history-chart', 'Detection History'),
]

/** The `live-stats` top tab the analytics addon contributes to a camera. */
export const LIVE_STATS_SECTION = {
  id: 'live-stats',
  title: 'Live Stats',
  tab: 'live-stats',
  location: 'top-tab',
  columns: 1,
  order: 0,
  fields: [
    {
      type: 'widget',
      key: 'liveStats',
      label: 'Live Stats',
      widgetId: 'pipeline-analytics/live-stats',
      span: 1,
    },
  ],
}

const CLASSES = ['person', 'vehicle', 'animal'] as const

/** Every 7 minutes over the last day, more by day than by night. */
const stamps = (stepMin: number, count: number): number[] =>
  Array.from({ length: count }, (_v, i) => NOW - i * stepMin * MINUTE).filter((t, i) => {
    const h = new Date(t).getUTCHours()
    return !(h >= 2 && h < 4) && (h > 6 || i % 3 === 0)
  })

export const MOTION_EVENTS = stamps(7, 205).map((timestamp, i) => ({
  id: `m-${String(i)}`,
  deviceId: 101,
  timestamp,
  kind: 'motion',
  regionCount: 1 + (i % 4),
}))

export const OBJECT_EVENTS = stamps(11, 130).map((timestamp, i) => ({
  id: `o-${String(i)}`,
  deviceId: 101,
  timestamp,
  kind: 'object',
  className: CLASSES[i % 5 === 0 ? 2 : i % 2] ?? 'person',
  score: 0.71 + (i % 20) / 100,
}))

export const AUDIO_HISTORY = {
  points: Array.from({ length: 120 }, (_v, i) => {
    const ts = NOW - (119 - i) * 30_000
    const dbfs = -48 + 8 * Math.sin(i / 9)
    return {
      ts,
      dbfs,
      peakDbfs: dbfs + 6,
      avgDbfs: dbfs - 2,
      topClass: i % 17 === 0 ? 'dog_bark' : null,
      topScore: i % 17 === 0 ? 0.62 : null,
    }
  }),
  effectiveSampleEveryMs: 30_000,
  windowMsActual: 3_600_000,
}

const BUCKET = 5 * MINUTE

/** Five-minute occupancy buckets over the last day, none while the camera was offline. */
export const OCCUPANCY_LTS = Array.from({ length: 288 }, (_v, i) => {
  const bucketStart = Math.floor((NOW - 288 * BUCKET) / BUCKET) * BUCKET + i * BUCKET
  const h = new Date(bucketStart).getUTCHours()
  const count = Math.max(
    0,
    Math.round((1.6 + 1.4 * Math.sin(i / 12)) * (h > 6 && h < 22 ? 3 : 0.5)),
  )
  return { scope: '', bucketStart, samples: 30, sum: count * 30, min: 0, max: count, last: count }
}).filter((r) => {
  const h = new Date(r.bucketStart).getUTCHours()
  return !(h >= 2 && h < 4)
})
