/**
 * Orphan series (D917): device series that are no longer linked to a device.
 *
 *  - `device-gone` — the device is absent from the successful device listings:
 *    the {@link DepartureTracker}'s clock is running for it. The same knowledge
 *    the week-long departure purge uses, but REPORTED here the moment the clock
 *    starts, so an admin can see it.
 *  - `undeclared` — a `cap:` key no capability declares any more (a cap field
 *    that was removed, such as the `vacuum-control` tank levels D915 moved into
 *    `consumables`). Capture never writes it again; only retention would age it.
 *
 * Nothing is deleted on this judgement alone (D49): an admin deletes, by id,
 * and each id is judged AGAIN at the moment of the delete — a device that came
 * back between the listing and the click keeps its history.
 */
import type {
  DeviceHistoryOrphanDeleteEntry,
  DeviceHistoryOrphanList,
  DeviceHistoryOrphanReason,
  DeviceHistoryOrphanSeries,
  DeviceHistoryTierRows,
  IScopedLogger,
} from '@camstack/types'
import { DEVICE_HISTORY_ORPHAN_LIST_MAX } from '@camstack/types'
import { CAP_KEY_PREFIX } from '../capture/capture-engine.js'
import type { HistoryStore, SeriesRecord } from '../store/history-store.js'
import type { SeriesRegistry } from '../store/series-registry.js'
import type { DepartureTracker } from './departure-tracker.js'
import type { RetentionJob } from './retention.js'

export interface OrphanVerdict {
  readonly reason: DeviceHistoryOrphanReason
  readonly missingSince: number | null
}

/**
 * The orphan verdict of one series, or `null` when it is linked. PURE. A node
 * series is never orphan here (its subject is a node, not a device).
 */
export function judgeOrphan(
  series: Pick<SeriesRecord, 'key' | 'deviceId'>,
  declaredCapKeys: ReadonlySet<string>,
  missingSince: number | undefined,
): OrphanVerdict | null {
  if (series.deviceId === null) return null
  if (missingSince !== undefined) return { reason: 'device-gone', missingSince }
  if (series.key.startsWith(CAP_KEY_PREFIX) && !declaredCapKeys.has(series.key)) {
    return { reason: 'undeclared', missingSince: null }
  }
  return null
}

export interface OrphanSeriesDeps {
  readonly store: HistoryStore
  readonly registry: SeriesRegistry
  readonly departures: DepartureTracker
  readonly retention: RetentionJob
  /** Every `cap:` series key the catalogs declare (fields and keyed-item fields). */
  readonly declaredCapKeys: ReadonlySet<string>
  readonly logger: IScopedLogger
  readonly clock: () => number
}

export class OrphanSeries {
  constructor(private readonly deps: OrphanSeriesDeps) {}

  private verdictOf(series: SeriesRecord): OrphanVerdict | null {
    const { departures, declaredCapKeys } = this.deps
    const missing = series.deviceId === null ? undefined : departures.missingSince(series.deviceId)
    return judgeOrphan(series, declaredCapKeys, missing)
  }

  /** Every orphan, ordered by device, key and scope, the first {@link DEVICE_HISTORY_ORPHAN_LIST_MAX} counted. */
  async list(): Promise<DeviceHistoryOrphanList> {
    const found = this.deps.registry
      .all()
      .flatMap((series) => {
        const verdict = this.verdictOf(series)
        return verdict === null || series.deviceId === null
          ? []
          : [{ series, deviceId: series.deviceId, verdict }]
      })
      .toSorted(
        (a, b) =>
          a.deviceId - b.deviceId ||
          a.series.key.localeCompare(b.series.key) ||
          a.series.scope.localeCompare(b.series.scope),
      )
    const out: DeviceHistoryOrphanSeries[] = []
    for (const { series, deviceId, verdict } of found.slice(0, DEVICE_HISTORY_ORPHAN_LIST_MAX)) {
      out.push({
        seriesId: series.id,
        deviceId,
        key: series.key,
        scope: series.scope,
        displayName: this.deps.registry.metric(series.key)?.displayName ?? null,
        reason: verdict.reason,
        missingSince: verdict.missingSince,
        firstTs: series.firstTs,
        lastTs: series.lastTs,
        rows: await this.rowsOf(series.id),
      })
    }
    return { series: out, truncated: found.length > DEVICE_HISTORY_ORPHAN_LIST_MAX }
  }

  private async rowsOf(seriesId: number): Promise<DeviceHistoryTierRows> {
    const { store } = this.deps
    return {
      raw: await store.countSeriesRows('raw', seriesId),
      '5m': await store.countSeriesRows('5m', seriesId),
      '1h': await store.countSeriesRows('1h', seriesId),
      '1d': await store.countSeriesRows('1d', seriesId),
    }
  }

  /** Delete orphans by id, one at a time, each re-judged now. One entry per id, in order. */
  async delete(seriesIds: readonly number[]): Promise<readonly DeviceHistoryOrphanDeleteEntry[]> {
    const out: DeviceHistoryOrphanDeleteEntry[] = []
    for (const seriesId of seriesIds) out.push(await this.deleteOne(seriesId))
    return out
  }

  private async deleteOne(seriesId: number): Promise<DeviceHistoryOrphanDeleteEntry> {
    const { registry, retention, logger, clock } = this.deps
    const series = registry.all().find((s) => s.id === seriesId)
    if (series === undefined) return { seriesId, ok: false, reason: 'not-found' }
    const verdict = this.verdictOf(series)
    if (verdict === null || series.deviceId === null) {
      logger.info('device-history: refused to delete a series that is not orphan', {
        ...(series.deviceId === null ? {} : { tags: { deviceId: series.deviceId } }),
        meta: { seriesId, key: series.key, scope: series.scope },
      })
      return { seriesId, ok: false, reason: 'not-orphan' }
    }
    try {
      const deleted = await retention.purgeSeries(series, clock())
      registry.remove(series.id)
      const rows: DeviceHistoryTierRows = {
        raw: deleted.raw,
        '5m': deleted['5m'],
        '1h': deleted['1h'],
        '1d': deleted['1d'],
      }
      logger.info('device-history: deleted an orphan series', {
        tags: { deviceId: series.deviceId },
        meta: { seriesId, key: series.key, scope: series.scope, reason: verdict.reason, rows },
      })
      return { seriesId, ok: true, deleted: rows }
    } catch (err) {
      logger.warn(
        'device-history: deleting an orphan series failed — it stays listed, retry the delete',
        {
          tags: { deviceId: series.deviceId },
          meta: {
            seriesId,
            key: series.key,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      )
      return { seriesId, ok: false, reason: 'failed' }
    }
  }
}
