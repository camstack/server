/**
 * The NARROW media-row forget: delete `pipeline-analytics:media` rows stamped
 * with ONE storage location whose file is provably gone — and nothing else.
 *
 * Why it exists: a location whose bytes were lost keeps rows naming it, and a
 * cascading cleanup is not an acceptable way to clear them. `reconcileFromDisk`
 * once cascaded ~132 k events away from a read it did not double-check. Here:
 *
 *  - **Only media rows.** No event, track, object-event, face, plate or
 *    identity row is deleted. A parent keeps existing with that media kind
 *    missing — which is exactly what it already serves (`getBytesById` answers
 *    `null` for a missing row as it does for a missing blob).
 *  - **Only `ENOENT` is absence (D49).** Each row's file is `stat`ed under the
 *    location's own root on THIS node. Any other errno keeps the row and is
 *    reported; a present file keeps the row and is reported (relocation is
 *    incomplete). A row with no path, a path that escapes the root, or a
 *    retention-exempt owner (the enrolled gallery) is kept.
 *  - **Only rows stamped with the id.** `locationId IS NULL` rows mean
 *    "wherever eventMedia points now" and are never selected.
 *  - **Only a location nothing writes to.** An active (writable) location is
 *    refused: new rows could land while the walk runs.
 *  - **Dry run first, then the same count.** Applying requires
 *    `expectAbsent`; the whole population is classified before any delete,
 *    and a different absent count refuses the call with nothing written.
 *    Each id is re-`stat`ed right before its batch is deleted, and the delete
 *    predicate repeats `locationId`, so a row repointed in between survives.
 *
 * Occupancy needs no separate bookkeeping: `storage-occupancy` sums
 * `sizeBytes WHERE locationId = ?` on demand, so the row IS the accounting.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { mayWriteToLocation } from '@camstack/types'
import { isMediaOwnerKind, MEDIA_COLLECTION } from '../store/media-store.js'
import { type DiscardLocationRow, locationBasePath } from './location-discard-policy.js'
import {
  MEDIA_FORGET_MAX_ROWS,
  type MediaForgetInput,
  MediaForgetInputSchema,
  type MediaForgetResult,
  type MediaForgetSample,
  type MediaForgetVerdictCounts,
} from './media-forget-actions.js'
import { isRetentionExemptOwnerKind } from './retention-model.js'

const PAGE_SIZE = 200
const DELETE_BATCH = 200
const DEFAULT_SAMPLE_SIZE = 20

export interface MediaForgetDeps {
  readonly listLocations: () => Promise<readonly DiscardLocationRow[]>
  readonly localNodeId: string
  readonly store: SettingsStoreClient
  readonly logger: IScopedLogger
  /** `fs.promises.stat` by default; resolves when the file exists. */
  readonly stat?: (absolutePath: string) => Promise<unknown>
  /** Yield between pages (hub-main's SQLite thread is shared). */
  readonly pace?: () => Promise<void>
}

type Verdict = 'absent' | 'present' | 'error' | 'kept'

interface ClassifiedRow {
  /** The store key, as the store spells it (whereIn on `id` takes the key). */
  readonly key: string
  readonly sample: MediaForgetSample
  readonly verdict: Verdict
  readonly absolutePath: string | null
}

function errnoOf(err: unknown): string {
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') return err.code
  return err instanceof Error ? err.message : String(err)
}

function emptyCounts(): MediaForgetVerdictCounts {
  return { rows: 0, absent: 0, present: 0, error: 0, kept: 0, deleted: 0 }
}

function tally(counts: MediaForgetVerdictCounts, verdict: Verdict): MediaForgetVerdictCounts {
  const rows = counts.rows + 1
  switch (verdict) {
    case 'absent':
      return { ...counts, rows, absent: counts.absent + 1 }
    case 'present':
      return { ...counts, rows, present: counts.present + 1 }
    case 'error':
      return { ...counts, rows, error: counts.error + 1 }
    case 'kept':
      return { ...counts, rows, kept: counts.kept + 1 }
  }
}

/** The file's absolute path under `root`, or `null` when it would escape it. */
function resolveUnder(root: string, relativePath: string): string | null {
  const base = path.resolve(root)
  const full = path.resolve(base, relativePath)
  return full.startsWith(base + path.sep) ? full : null
}

function toSample(id: string, data: Readonly<Record<string, unknown>>): MediaForgetSample {
  return {
    mediaId: Number(id),
    deviceId: Number(data['deviceId'] ?? 0),
    kind: String(data['kind'] ?? ''),
    ownerKind: String(data['ownerKind'] ?? ''),
    ownerId: String(data['ownerId'] ?? ''),
    path: String(data['path'] ?? ''),
  }
}

async function probe(
  stat: (p: string) => Promise<unknown>,
  absolutePath: string,
): Promise<{ verdict: 'absent' | 'present' | 'error'; reason?: string }> {
  try {
    await stat(absolutePath)
    return { verdict: 'present' }
  } catch (err) {
    const code = errnoOf(err)
    return code === 'ENOENT' ? { verdict: 'absent' } : { verdict: 'error', reason: code }
  }
}

async function classify(
  stat: (p: string) => Promise<unknown>,
  root: string,
  id: string,
  data: Readonly<Record<string, unknown>>,
): Promise<ClassifiedRow> {
  const sample = toSample(id, data)
  const ownerKind = sample.ownerKind
  if (isMediaOwnerKind(ownerKind) && isRetentionExemptOwnerKind(ownerKind)) {
    return {
      key: id,
      sample: { ...sample, reason: 'retention-exempt owner' },
      verdict: 'kept',
      absolutePath: null,
    }
  }
  if (sample.path.length === 0) {
    return {
      key: id,
      sample: { ...sample, reason: 'no path' },
      verdict: 'kept',
      absolutePath: null,
    }
  }
  const absolutePath = resolveUnder(root, sample.path)
  if (absolutePath === null) {
    return {
      key: id,
      sample: { ...sample, reason: 'path escapes the root' },
      verdict: 'kept',
      absolutePath,
    }
  }
  const result = await probe(stat, absolutePath)
  return {
    key: id,
    sample: result.reason === undefined ? sample : { ...sample, reason: result.reason },
    verdict: result.verdict,
    absolutePath,
  }
}

function resolveTarget(
  locations: readonly DiscardLocationRow[],
  locationId: string,
  localNodeId: string,
): { location: DiscardLocationRow; root: string } {
  const location = locations.find((row) => row.id === locationId)
  if (!location) throw new Error(`forgetMissingMedia refused: unknown location ${locationId}`)
  if (location.type !== 'eventMedia') {
    throw new Error(
      `forgetMissingMedia refused: ${locationId} is ${location.type}, pipeline-analytics owns eventMedia rows only`,
    )
  }
  if (mayWriteToLocation(location)) {
    throw new Error(
      `forgetMissingMedia refused: ${locationId} is still a write target — set it to drain, readonly or disabled first`,
    )
  }
  const nodeId = location.nodeId === undefined || location.nodeId === '' ? 'hub' : location.nodeId
  if (nodeId !== localNodeId) {
    throw new Error(
      `forgetMissingMedia refused: ${locationId} lives on node ${nodeId}, this process is ${localNodeId}`,
    )
  }
  return { location, root: locationBasePath(location) }
}

/**
 * Classify every row stamped with `input.locationId` (bounded by `maxRows`),
 * and — only when `dryRun` is false and the absent count equals
 * `expectAbsent` — delete the absent ones, per camera, in batches.
 */
export async function forgetMissingMediaRows(
  deps: MediaForgetDeps,
  rawInput: MediaForgetInput,
): Promise<MediaForgetResult> {
  const input = MediaForgetInputSchema.parse(rawInput)
  if (!input.dryRun && input.expectAbsent === undefined) {
    throw new Error(
      'forgetMissingMedia refused: an apply needs expectAbsent (the dry run’s totals.absent)',
    )
  }
  const stat = deps.stat ?? ((p: string) => fs.stat(p))
  const pace = deps.pace ?? (() => new Promise<void>((resolve) => setImmediate(resolve)))
  const maxRows = input.maxRows ?? MEDIA_FORGET_MAX_ROWS
  const sampleSize = input.sampleSize ?? DEFAULT_SAMPLE_SIZE
  const { root } = resolveTarget(await deps.listLocations(), input.locationId, deps.localNodeId)

  // ── Phase 1: classify. Writes nothing. ───────────────────────────────
  const classified: ClassifiedRow[] = []
  let cursor = 0
  let truncated = false
  for (;;) {
    const rows = await deps.store.query.query({
      collection: MEDIA_COLLECTION,
      columns: ['id', 'deviceId', 'ownerKind', 'ownerId', 'kind', 'path'],
      filter: {
        where: { locationId: input.locationId },
        ...(input.deviceIds ? { whereIn: { deviceId: [...input.deviceIds] } } : {}),
        whereBetween: { id: [cursor + 1, Number.MAX_SAFE_INTEGER] },
        orderBy: { field: 'id', direction: 'asc' },
        limit: PAGE_SIZE,
      },
    })
    if (rows.length === 0) break
    for (const row of rows) {
      if (classified.length >= maxRows) {
        truncated = true
        break
      }
      classified.push(await classify(stat, root, row.id, row.data))
      cursor = Math.max(cursor, Number(row.id))
    }
    if (truncated || rows.length < PAGE_SIZE) break
    await pace()
  }

  const absentRows = classified.filter((c) => c.verdict === 'absent')
  const deletedIds = new Set<number>()
  let changedBeforeDelete = 0

  if (!input.dryRun) {
    if (absentRows.length !== input.expectAbsent) {
      throw new Error(
        `forgetMissingMedia refused: ${String(absentRows.length)} rows are absent now, expectAbsent was ${String(input.expectAbsent)} — run the dry run again; nothing was deleted`,
      )
    }
    // ── Phase 2: delete, per camera, re-probing each id first. ──────────
    const byDevice = new Map<number, ClassifiedRow[]>()
    for (const row of absentRows) {
      byDevice.set(row.sample.deviceId, [...(byDevice.get(row.sample.deviceId) ?? []), row])
    }
    for (const [deviceId, rows] of byDevice) {
      for (let at = 0; at < rows.length; at += DELETE_BATCH) {
        const batch: ClassifiedRow[] = []
        for (const row of rows.slice(at, at + DELETE_BATCH)) {
          const again = row.absolutePath === null ? null : await probe(stat, row.absolutePath)
          if (again?.verdict === 'absent') batch.push(row)
          else changedBeforeDelete += 1
        }
        if (batch.length === 0) continue
        const { deleted } = await deps.store.deleteWhere.mutate({
          collection: MEDIA_COLLECTION,
          filter: {
            where: { locationId: input.locationId, deviceId },
            whereIn: { id: batch.map((row) => row.key) },
          },
        })
        for (const row of batch) deletedIds.add(row.sample.mediaId)
        deps.logger.info('forgetMissingMedia: forgot media rows whose file is gone', {
          tags: { deviceId },
          meta: {
            locationId: input.locationId,
            batch: batch.length,
            deleted,
            firstId: batch[0]?.sample.mediaId,
            lastId: batch[batch.length - 1]?.sample.mediaId,
          },
        })
        if (deleted !== batch.length) {
          deps.logger.warn('forgetMissingMedia: a batch deleted fewer rows than it named', {
            tags: { deviceId },
            meta: {
              locationId: input.locationId,
              batch: batch.length,
              deleted,
            },
          })
        }
        await pace()
      }
    }
  }

  // ── Report ───────────────────────────────────────────────────────────
  let totals = emptyCounts()
  const perDevice = new Map<number, MediaForgetVerdictCounts>()
  const perKind = new Map<string, MediaForgetVerdictCounts>()
  for (const row of classified) {
    const isDeleted = deletedIds.has(row.sample.mediaId)
    const bump = (c: MediaForgetVerdictCounts): MediaForgetVerdictCounts => {
      const next = tally(c, row.verdict)
      return isDeleted ? { ...next, deleted: next.deleted + 1 } : next
    }
    totals = bump(totals)
    perDevice.set(row.sample.deviceId, bump(perDevice.get(row.sample.deviceId) ?? emptyCounts()))
    perKind.set(row.sample.kind, bump(perKind.get(row.sample.kind) ?? emptyCounts()))
  }
  const samplesOf = (verdict: Verdict): MediaForgetSample[] =>
    classified
      .filter((c) => c.verdict === verdict)
      .slice(0, sampleSize)
      .map((c) => c.sample)

  for (const [deviceId, counts] of perDevice) {
    deps.logger.info('forgetMissingMedia: per-camera verdict', {
      tags: { deviceId },
      meta: { locationId: input.locationId, dryRun: input.dryRun, ...counts },
    })
  }

  return {
    locationId: input.locationId,
    dryRun: input.dryRun,
    root,
    truncated,
    totals,
    byDevice: [...perDevice].map(([deviceId, c]) => ({ deviceId, ...c })),
    byKind: [...perKind].map(([kind, c]) => ({ kind, ...c })),
    absentIds: absentRows.map((r) => r.sample.mediaId),
    samples: {
      absent: samplesOf('absent'),
      present: samplesOf('present'),
      error: samplesOf('error'),
      kept: samplesOf('kept'),
    },
    changedBeforeDelete,
  }
}
