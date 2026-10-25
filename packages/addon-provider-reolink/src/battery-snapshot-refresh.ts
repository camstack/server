/**
 * Refresh the snapshot wrapper's cached frame for ONE battery camera and say
 * whether the frame is really new.
 *
 * `snapshot.getSnapshot({ force })` answers a stale cached frame when the
 * capture fails (stale beats blank, by design), so "it returned an image" is
 * not evidence that the cache moved. The wrapper's overview reports when the
 * cached frame was captured; the refresh counts only if that is no older than
 * the moment this refresh began. An overview that cannot be read degrades to
 * "an image came back" and says so — it never fabricates a failure.
 *
 * The caller owns the right to wake: `force` walks past the wrapper's sleep
 * gate, so this runs only for a camera that is up.
 */
import type { IScopedLogger } from '@camstack/types'

/** The wrapper may run on another node; a stale frame is hours old, skew is seconds. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000

export interface SnapshotOverviewRow {
  readonly deviceId: number
  readonly lastCapturedAt: number | null
}

/** The two wrapper calls this needs, as structural dependencies. */
export interface SnapshotWrapperApi {
  readonly getSnapshot: (input: {
    readonly deviceId: number
    readonly force: boolean
  }) => Promise<{ readonly base64: string } | null>
  readonly getSnapshotOverview: (input: {
    readonly deviceIds: readonly number[]
  }) => Promise<readonly SnapshotOverviewRow[]>
}

export async function refreshSnapshotCacheOnce(input: {
  readonly deviceId: number
  readonly api: SnapshotWrapperApi
  readonly logger: IScopedLogger
  readonly now: () => number
}): Promise<boolean> {
  const { deviceId, api, logger } = input
  const startedAt = input.now()
  const image = await api.getSnapshot({ deviceId, force: true })
  if (image === null) {
    logger.warn('battery hourly refresh: the snapshot came back empty', {
      tags: { deviceId },
    })
    return false
  }
  let rows: readonly SnapshotOverviewRow[]
  try {
    rows = await api.getSnapshotOverview({ deviceIds: [deviceId] })
  } catch (err) {
    logger.debug('battery hourly refresh: snapshot overview unreadable — counting the image', {
      tags: { deviceId },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    return true
  }
  const capturedAt = rows.find((row) => row.deviceId === deviceId)?.lastCapturedAt ?? null
  if (capturedAt === null || capturedAt < startedAt - CLOCK_SKEW_TOLERANCE_MS) {
    logger.warn(
      'battery hourly refresh: the snapshot cache did not move (a stale frame was served)',
      {
        tags: { deviceId },
        meta: { capturedAt, startedAt },
      },
    )
    return false
  }
  return true
}
