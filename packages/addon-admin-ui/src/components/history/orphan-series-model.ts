/**
 * Orphan history series (D917): the pure half of the History page's
 * "series no longer linked to a device" review.
 *
 * The hub deletes at most `DEVICE_HISTORY_ORPHAN_DELETE_MAX` ids per call and
 * re-judges each id at that moment, so a selection is sent in batches and
 * every id gets its own outcome: deleted (with the rows per tier), refused by
 * the hub (`not-found` / `not-orphan` / `failed`), or never answered because
 * the whole batch's request failed.
 */
import {
  DEVICE_HISTORY_ORPHAN_DELETE_MAX,
  type DeviceHistoryOrphanDeleteEntry,
  type DeviceHistoryOrphanSeries,
  type DeviceHistoryTierRows,
} from '@camstack/types'

/** A batch whose request failed: no id in it was judged by the hub. */
export interface OrphanRequestFailed {
  readonly seriesId: number
  readonly ok: false
  readonly reason: 'request-failed'
  readonly message: string
}

export type OrphanDeleteOutcome = DeviceHistoryOrphanDeleteEntry | OrphanRequestFailed

export type OrphanDeleteCall = (
  seriesIds: readonly number[],
) => Promise<{ readonly results: readonly DeviceHistoryOrphanDeleteEntry[] }>

export function chunkIds(ids: readonly number[], size: number): readonly (readonly number[])[] {
  const out: (readonly number[])[] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/**
 * Delete `ids` in batches of at most {@link DEVICE_HISTORY_ORPHAN_DELETE_MAX},
 * one after the other. An id the hub did not mention in its answer is
 * reported `not-found` rather than dropped.
 */
export async function deleteOrphansInBatches(
  ids: readonly number[],
  call: OrphanDeleteCall,
): Promise<readonly OrphanDeleteOutcome[]> {
  const outcomes: OrphanDeleteOutcome[] = []
  for (const batch of chunkIds(ids, DEVICE_HISTORY_ORPHAN_DELETE_MAX)) {
    try {
      const { results } = await call(batch)
      const byId = new Map(results.map((r) => [r.seriesId, r] as const))
      for (const id of batch) {
        outcomes.push(byId.get(id) ?? { seriesId: id, ok: false, reason: 'not-found' })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      for (const id of batch) {
        outcomes.push({ seriesId: id, ok: false, reason: 'request-failed', message })
      }
    }
  }
  return outcomes
}

export function totalRows(rows: DeviceHistoryTierRows): number {
  return rows.raw + rows['5m'] + rows['1h'] + rows['1d']
}

export interface OrphanDeleteSummary {
  readonly deleted: number
  readonly refused: number
  readonly points: number
}

export function summarizeOutcomes(outcomes: readonly OrphanDeleteOutcome[]): OrphanDeleteSummary {
  return outcomes.reduce<OrphanDeleteSummary>(
    (acc, o) =>
      o.ok
        ? { ...acc, deleted: acc.deleted + 1, points: acc.points + totalRows(o.deleted) }
        : { ...acc, refused: acc.refused + 1 },
    { deleted: 0, refused: 0, points: 0 },
  )
}

/** One deleted-or-refused row, kept with the series it was about (the list refreshes without it). */
export interface OrphanOutcomeRow {
  readonly series: DeviceHistoryOrphanSeries
  readonly outcome: OrphanDeleteOutcome
}

export function pairOutcomes(
  series: readonly DeviceHistoryOrphanSeries[],
  outcomes: readonly OrphanDeleteOutcome[],
): readonly OrphanOutcomeRow[] {
  const byId = new Map(series.map((s) => [s.seriesId, s] as const))
  return outcomes.flatMap((outcome) => {
    const s = byId.get(outcome.seriesId)
    return s === undefined ? [] : [{ series: s, outcome }]
  })
}
