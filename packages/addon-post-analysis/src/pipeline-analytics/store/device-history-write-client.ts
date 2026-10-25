import type { AddonApi } from '@camstack/types'
import type { DeviceHistoryWriteClient } from './analytics-history-producer.js'

/** Adapt tRPC-shaped `ctx.api.deviceHistory` to the producer's plain async surface. */
export function deviceHistoryWriteClient(api: AddonApi['deviceHistory']): DeviceHistoryWriteClient {
  return {
    declareSeries: (input) => api.declareSeries.mutate(input),
    record: (input) => api.record.mutate({ points: [...input.points] }),
    recordBuckets: (input) => api.recordBuckets.mutate({ buckets: [...input.buckets] }),
    query: (input) => api.query.query(input),
  }
}
