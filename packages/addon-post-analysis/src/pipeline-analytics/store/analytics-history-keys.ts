import { AnalyticsLtsSeriesSchema } from '@camstack/types'
import type { z } from 'zod'

export type AnalyticsLtsSeries = z.infer<typeof AnalyticsLtsSeriesSchema>

/** Declared addon series keys (D850). */
export const ANALYTICS_HISTORY_BUCKET_SERIES = {
  motion: 'addon:pipeline-analytics/motion',
  'audio-dbfs': 'addon:pipeline-analytics/audio-dbfs',
  occupancy: 'addon:pipeline-analytics/occupancy',
} as const satisfies Record<
  Exclude<AnalyticsLtsSeries, 'battery'>,
  `addon:pipeline-analytics/${string}`
>

export const ANALYTICS_AUDIO_LEVEL_KEY = 'addon:pipeline-analytics/audio-level'

export type AnalyticsHistoryBucketSeriesName = keyof typeof ANALYTICS_HISTORY_BUCKET_SERIES

/** Map the public cap enum to the device-history key (read path). */
export function historyKeyForLtsSeries(series: AnalyticsLtsSeries): string {
  if (series === 'battery') return 'cap:battery.percentage'
  return ANALYTICS_HISTORY_BUCKET_SERIES[series]
}
