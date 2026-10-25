/**
 * A raw-delete reclaim (plates, object-events) is COUNTED, through the real
 * audit loop — and so the per-scope ceiling bounds it.
 *
 * The defect (pre-existing, found in the D695 review round): the `deleteRow`
 * port read `settingsStore.delete` — whose output is `z.void()` — as
 * `!== undefined`, so every raw reclaim answered `rows: 0`. The engine reads
 * that as "the delete found nothing" and counts nothing: the row WAS deleted,
 * `reclaimed` stayed 0, and `maxReclaimPerScope` (the bound on what one sweep
 * may delete) never tripped — a sweep deleted every orphan it walked.
 *
 * Wired here exactly as production wires it: plates are a records kind, paged
 * by keyset and deleted through the plate ledger (`orphan-audit-ledgers.ts`);
 * any other collection is paged on the settings store and deleted through
 * `settingsRowDeleterOf`; the real `buildOrphanReclaimer` and `auditScope`.
 *
 * Disarms (each alone, restored byte-identical):
 *  - `deleted >= 0` (a reclaim whatever the count): "nothing to delete is not
 *    a reclaim" fails;
 *  - answer `false` after the delete (the old behaviour: the row goes, the
 *    answer says it did not): "counts what it deleted" fails — 0 reclaimed,
 *    and the ceiling never trips;
 *  - `settingsRowDeleterOf` answering `false` for an unbound store: "refuses
 *    to answer for a store that is not bound" fails;
 *  - the "freed no bytes" WARN gated on bytes alone again: "stays quiet when
 *    a byte-less collection reclaimed its orphans" fails.
 * The production WIRING (index.ts → `settingsRowDeleterOf`) is held by
 * `scripts/check-orphan-reclaimers.ts`: restoring the original inline
 * `delete.mutate(...) !== undefined` turns that guard red.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { kindRows, makeAnalyticsWorld, seedLedgerRows } from '../../__tests__/fake-records.js'
import { makeFakeSettingsStore, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { PLATES_COLLECTION } from '../../store/plate-store.js'
import {
  auditScope,
  buildOrphanScopes,
  DEFAULT_ORPHAN_LIMITS,
  type OrphanAuditDeps,
  type OrphanScope,
} from '../orphan-audit.js'
import {
  buildOrphanReclaimer,
  settingsRowDeleter,
  settingsRowDeleterOf,
} from '../orphan-reclaimers.js'
import { keysetPager, plateDeleter } from '../orphan-audit-ledgers.js'

const NOW = 10_000_000_000
const OLD = NOW - 90 * 24 * 60 * 60 * 1000

function platesScope(): OrphanScope {
  const scope = buildOrphanScopes().find((s) => s.collection === PLATES_COLLECTION)
  if (scope === undefined) throw new Error('plates is not an audited collection')
  return scope
}

interface HarnessOptions {
  readonly logger?: IScopedLogger
  readonly failDeletes?: boolean
}

async function harness(orphans: number, opts: HarnessOptions = {}) {
  const fake = makeFakeSettingsStore()
  const { world, ledgers } = await makeAnalyticsWorld()
  await seedLedgerRows(
    ledgers.plates,
    Array.from({ length: orphans }, (_unused, i) => {
      const id = `plate-${String(i).padStart(3, '0')}`
      return {
        id,
        data: { id, deviceId: 101, trackId: `dead-${i}`, timestamp: OLD, assigned: false },
      }
    }),
  )
  const store = fake.client
  const remaining = async (): Promise<number> => kindRows(world, 'plates').length
  const deps: OrphanAuditDeps = {
    // As production pages a records-backed collection (pipeline-analytics/index.ts).
    pageKeyset: keysetPager(new Map([[PLATES_COLLECTION, ledgers.plates]])),
    // As production pages a settings collection (pipeline-analytics/index.ts).
    page: async (collection, _shard, offset, limit) => {
      const rows = await store.query.query({
        collection,
        filter: { orderBy: { field: 'id', direction: 'asc' }, limit, offset },
      })
      return rows.map((row) => ({ key: row.id, data: row.data }))
    },
    size: async () => remaining(),
    liveTrackIds: async () => new Set<string>(),
    liveEventIds: async () => new Set<string>(),
    reclaim: (collection, key, row) =>
      buildOrphanReclaimer({
        deleteFace: async () => {
          throw new Error('not a face')
        },
        deleteMediaConfirmed: async () => {
          throw new Error('not media')
        },
        deleteTrackAlias: async () => {
          throw new Error('not an alias')
        },
        // Plates go through the plate LEDGER, as index.ts wires it.
        deletePlate: opts.failDeletes
          ? async () => {
              throw new Error('disk I/O error')
            }
          : plateDeleter(ledgers.plates, makeSilentLogger()),
        // The PRODUCTION factory, exactly as pipeline-analytics/index.ts wires it.
        deleteRow: opts.failDeletes
          ? async () => {
              throw new Error('disk I/O error')
            }
          : settingsRowDeleterOf(() => store),
        logger: makeSilentLogger(),
      })(collection, key, row.data),
    now: () => NOW,
    logger: opts.logger ?? makeSilentLogger(),
  }
  return { store, deps, remaining }
}

describe('orphan audit — a raw-delete reclaim is counted', () => {
  it('counts what it deleted, and the per-scope ceiling stops the deleting', async () => {
    const h = await harness(12)

    const report = await auditScope(
      platesScope(),
      h.deps,
      { ...DEFAULT_ORPHAN_LIMITS, mode: 'reclaim', pageSize: 5, maxReclaimPerScope: 4 },
      0,
    )

    expect(report.reclaimed).toBe(4)
    expect(report.stoppedBy).toBe('reclaim-ceiling')
    // The bound is on what is DELETED, not only on what is reported.
    expect(await h.remaining()).toBe(8)
  })

  it('nothing to delete is not a reclaim', async () => {
    const h = await harness(0)
    const deleteRow = settingsRowDeleter(h.store)

    expect(await deleteRow(PLATES_COLLECTION, 'plate-missing')).toBe(false)
  })

  it('an object-events delete with the dead trackId spares a reused live row (D694)', async () => {
    const fake = makeFakeSettingsStore()
    const OBJECT = 'pipeline-analytics:object-events'
    // The id the audit judged orphaned — already reused by a different track.
    fake.seed(OBJECT, [
      {
        id: '292786',
        data: {
          id: '292786',
          deviceId: 101,
          trackId: 'live-track',
          timestamp: NOW,
        },
      },
    ])
    const deleteRow = settingsRowDeleter(fake.client)

    expect(await deleteRow(OBJECT, '292786', { trackId: 'dead-track' })).toBe(false)
    expect(fake.size(OBJECT)).toBe(1)
    // Id-only would have deleted the live holder; the matching trackId does.
    expect(await deleteRow(OBJECT, '292786', { trackId: 'live-track' })).toBe(true)
    expect(fake.size(OBJECT)).toBe(0)
  })

  it('the production factory refuses to answer for a store that is not bound', async () => {
    // An unbound store used to answer "nothing deleted" — indistinguishable
    // from a row that was already gone. A throw is counted as reclaimFailed
    // and WARNed by the engine, with the row kept.
    const deleteRow = settingsRowDeleterOf(() => null)

    await expect(deleteRow(PLATES_COLLECTION, 'plate-000')).rejects.toThrow(/not bound/)
  })
})

function warnSpy(): { logger: IScopedLogger; warned: string[] } {
  const warned: string[] = []
  const silent = makeSilentLogger()
  const logger: IScopedLogger = {
    ...silent,
    warn: (message: string) => {
      warned.push(message)
    },
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, warned }
}

describe('orphan audit — "freed no bytes" is about collections that HAVE bytes', () => {
  const NO_BYTES = 'orphan audit: reclaim pass freed no bytes against a standing backlog'

  it('stays quiet when a byte-less collection reclaimed its orphans', async () => {
    // plates declare no size field: bytesReclaimed is 0 by construction, so
    // the WARN contradicted its own `reclaimed` on every successful pass.
    const spy = warnSpy()
    const h = await harness(3, { logger: spy.logger })

    const report = await auditScope(
      platesScope(),
      h.deps,
      { ...DEFAULT_ORPHAN_LIMITS, mode: 'reclaim', pageSize: 5 },
      0,
    )

    expect(report.reclaimed).toBe(3)
    expect(spy.warned).not.toContain(NO_BYTES)
  })

  it('still WARNs when a byte-less collection reclaimed nothing', async () => {
    const spy = warnSpy()
    const h = await harness(3, { logger: spy.logger, failDeletes: true })

    const report = await auditScope(
      platesScope(),
      h.deps,
      { ...DEFAULT_ORPHAN_LIMITS, mode: 'reclaim', pageSize: 5 },
      0,
    )

    expect(report.reclaimed).toBe(0)
    expect(spy.warned).toContain(NO_BYTES)
  })
})
