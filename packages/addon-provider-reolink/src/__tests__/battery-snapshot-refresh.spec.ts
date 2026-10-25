import { describe, expect, it } from 'vitest'
import {
  refreshSnapshotCacheOnce,
  type SnapshotOverviewRow,
  type SnapshotWrapperApi,
} from '../battery-snapshot-refresh.js'
import { createRecordingLogger } from './clip-test-logger.js'

const NOW = 1_800_000_000_000

function run(api: SnapshotWrapperApi) {
  const logger = createRecordingLogger()
  const done = refreshSnapshotCacheOnce({ deviceId: 106, api, logger, now: () => NOW })
  return { done, logger }
}

function apiWith(
  image: { base64: string } | null,
  rows: readonly SnapshotOverviewRow[] | Error,
): SnapshotWrapperApi {
  return {
    getSnapshot: async (input) => {
      expect(input).toEqual({ deviceId: 106, force: true })
      return image
    },
    getSnapshotOverview: async () => {
      if (rows instanceof Error) throw rows
      return rows
    },
  }
}

describe('snapshot cache refresh for the scheduled battery refresh', () => {
  it('counts a frame the cache really captured now', async () => {
    const { done } = run(apiWith({ base64: 'x' }, [{ deviceId: 106, lastCapturedAt: NOW + 500 }]))
    await expect(done).resolves.toBe(true)
  })

  it('does not count a stale frame served after a failed capture', async () => {
    const { done, logger } = run(
      apiWith({ base64: 'x' }, [{ deviceId: 106, lastCapturedAt: NOW - 6 * 60 * 60_000 }]),
    )
    await expect(done).resolves.toBe(false)
    expect(logger.warns[0]?.extras.tags).toEqual({ deviceId: 106 })
  })

  it('does not count an empty answer', async () => {
    const { done } = run(apiWith(null, []))
    await expect(done).resolves.toBe(false)
  })

  it('an unreadable overview degrades to "an image came back"', async () => {
    const { done } = run(apiWith({ base64: 'x' }, new Error('no route')))
    await expect(done).resolves.toBe(true)
  })
})
