/**
 * D480 — a bulk sweep covers the WHOLE collection or it covers the head.
 *
 * The orphan audit was correctly wired, ran every six hours in `reclaim` mode,
 * and had never looked at 96 % of `pipeline-analytics:media`. It walked the
 * collection by `ORDER BY id ASC` with an OFFSET cursor, a 20 000-row ceiling
 * and a cursor in RAM, in a process that respawns several times a day — so
 * every pass re-walked offsets 0–20 000 and stopped, and `track:` sorts last,
 * which is where 23 594 rows / 9 714 MiB of orphans had accumulated.
 *
 * Every assertion here is one of the five things that has to hold for that to
 * be impossible rather than unlikely:
 *
 *  1. a mosaic is owned by its WRITER's bound, not by a table its id was never
 *     in — the audit never probes it and never deletes it;
 *  2. the retired `'event'` owner kind reaches the bounded, byte-deleting
 *     retired-owner path;
 *  3. the walk is SHARDED by owner kind and the cursor SURVIVES a respawn, so
 *     no owner kind is starved by another's volume;
 *  4. a reclaim whose blob did not go keeps its row — and the bytes reported
 *     are the ones the delete itself confirmed;
 *  5. the event probe is PER TABLE: after D474 every object and audio id is
 *     also a motion id, so a union answers "live" for rows that are dead.
 *
 * Plus the property that made the blind spot invisible for ten days: a scope
 * reports its SIZE, and a pass that covered a fraction of it says so.
 */
import { describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../__tests__/test-helpers.js'
import {
  MEDIA_COLLECTION,
  OWNER_KINDS,
  RETIRED_OWNER_KINDS,
  SUMMARY_MOSAIC_OWNER_KIND,
} from '../../store/media-store.js'
import { RETENTION_EXEMPT_OWNER_KINDS } from '../retention-model.js'
import {
  auditScope,
  buildOrphanScopes,
  DEFAULT_ORPHAN_LIMITS,
  MEDIA_AUDIT_SHARD_KINDS,
  type OrphanAuditDeps,
  type OrphanAuditLimits,
  type OrphanRow,
  type OrphanScope,
  type OrphanShard,
  resolveMediaOwner,
  runOrphanAudit,
} from '../orphan-audit.js'

const NOW = 10_000_000_000
const HOUR = 60 * 60 * 1000
const OLD = NOW - 90 * 24 * HOUR

const RECLAIM: OrphanAuditLimits = { ...DEFAULT_ORPHAN_LIMITS, mode: 'reclaim' }

function mediaRow(
  key: string,
  ownerKind: string,
  ownerId: string,
  extra: Record<string, unknown> = {},
): OrphanRow {
  return {
    key,
    data: { ownerKind, ownerId, deviceId: 101, timestamp: OLD, sizeBytes: 1_000, ...extra },
  }
}

function shardOf(row: OrphanRow, shard: OrphanShard | null): boolean {
  return shard === null || row.data[shard.field] === shard.value
}

interface Harness {
  readonly deps: OrphanAuditDeps
  readonly reclaimed: string[]
  readonly logs: ReturnType<typeof makeLogRecorder>
  readonly probed: { table: string; ids: readonly string[] }[]
}

function harness(input: {
  rows: readonly OrphanRow[]
  liveTracks?: readonly string[]
  /** Live event ids PER TABLE — the whole point of the per-table probe. */
  liveEvents?: Readonly<Record<string, readonly string[]>>
  /** Keys whose blob refuses to go: `reclaim` throws, exactly as
   *  `deleteConfirmed` does when the unlink cannot be confirmed. */
  unlinkFails?: readonly string[]
  /** `null` = the collection size is unknown. Never `0`. */
  sizeAnswers?: boolean
}): Harness {
  const reclaimed: string[] = []
  const probed: { table: string; ids: readonly string[] }[] = []
  const logs = makeLogRecorder()
  const live = new Set(input.liveTracks ?? [])
  const unlinkFails = new Set(input.unlinkFails ?? [])
  const remaining = (): readonly OrphanRow[] => input.rows.filter((r) => !reclaimed.includes(r.key))
  const deps: OrphanAuditDeps = {
    page: async (_collection, shard, offset, limit) =>
      remaining()
        .filter((row) => shardOf(row, shard))
        .slice(offset, offset + limit),
    size: async (_collection, shard) =>
      input.sizeAnswers === false ? null : remaining().filter((row) => shardOf(row, shard)).length,
    liveTrackIds: async (ids) => new Set(ids.filter((id) => live.has(id))),
    liveEventIds: async (table, ids) => {
      probed.push({ table, ids })
      const liveInTable = new Set(input.liveEvents?.[table] ?? [])
      return new Set(ids.filter((id) => liveInTable.has(id)))
    },
    reclaim: async (_collection, key, _row) => {
      if (unlinkFails.has(key)) throw new Error(`media blob survived its delete: ${key}`)
      reclaimed.push(key)
      const row = input.rows.find((r) => r.key === key)
      const bytes = row === undefined ? 0 : Number(row.data['sizeBytes'] ?? 0)
      return { rows: 1, bytes }
    },
    now: () => NOW,
    logger: logs.logger,
  }
  return { deps, reclaimed, logs, probed }
}

function mediaScope(ownerKind: string): OrphanScope {
  const scope = buildOrphanScopes().find(
    (s) => s.collection === MEDIA_COLLECTION && s.shard?.value === ownerKind,
  )
  if (scope === undefined) throw new Error(`no media shard for '${ownerKind}'`)
  return scope
}

// ── 1. A synthetic owner id gets its own owner kind ──────────────────────

describe('a summary mosaic is owned by its writer, not by a table', () => {
  it('is a declared owner kind of its own — never a borrowed one', () => {
    expect(OWNER_KINDS).toContain(SUMMARY_MOSAIC_OWNER_KIND)
    // The two mistakes it must not repeat: `event` (the 675 rows this record
    // is about) and `object` (D476's pragmatic borrow).
    expect(SUMMARY_MOSAIC_OWNER_KIND).not.toBe('event')
    expect(SUMMARY_MOSAIC_OWNER_KIND).not.toBe('object')
  })

  it('resolves to WRITER-BOUNDED: the audit has no table to probe and deletes nothing', async () => {
    expect(resolveMediaOwner(mediaRow('a', SUMMARY_MOSAIC_OWNER_KIND, 'rule-1'))).toEqual({
      kind: 'writer-bounded',
      ownerKind: SUMMARY_MOSAIC_OWNER_KIND,
      why: expect.stringContaining('writer'),
    })
    // Even handed to the engine in reclaim mode with nothing alive anywhere.
    const h = harness({ rows: [mediaRow('a', SUMMARY_MOSAIC_OWNER_KIND, 'rule-1')] })
    const report = await auditScope(
      { ...mediaScope('track'), shard: null, id: 'forced' },
      h.deps,
      RECLAIM,
      0,
    )
    expect(h.reclaimed).toEqual([])
    expect(report.writerBounded).toBe(1)
    expect(report.orphans).toBe(0)
  })

  it('is NOT walked as a shard — its lifetime is not a question the sweep asks', () => {
    expect(MEDIA_AUDIT_SHARD_KINDS).not.toContain(SUMMARY_MOSAIC_OWNER_KIND)
  })
})

// ── 2. `event` is retired, so the leftovers are reachable ────────────────

describe("the retired 'event' owner kind", () => {
  it('is a RETIRED owner kind — no probe, and reclaimable under the usual bounds', async () => {
    expect(RETIRED_OWNER_KINDS).toContain('event')
    expect(OWNER_KINDS as readonly string[]).not.toContain('event')
    expect(resolveMediaOwner(mediaRow('legacy', 'event', 'summary-rule-1-1789'))).toEqual({
      kind: 'retired-owner',
      ownerKind: 'event',
    })
    const rows = [
      mediaRow('legacy-1', 'event', 'summary-r-1', { sizeBytes: 400_000 }),
      mediaRow('legacy-2', 'event', 'edd73f47', { sizeBytes: 100_000 }),
    ]
    const h = harness({ rows })
    const report = await auditScope(mediaScope('event'), h.deps, RECLAIM, 0)
    expect(h.reclaimed).toEqual(['legacy-1', 'legacy-2'])
    expect(report.bytesReclaimed).toBe(500_000)
  })

  it('has a shard of its own, or nothing would ever walk it', () => {
    expect(MEDIA_AUDIT_SHARD_KINDS).toContain('event')
  })
})

// ── 3. The walk is sharded, and the cursor survives a respawn ────────────

describe('the walk is sharded by owner kind', () => {
  it('every owner kind that CAN orphan has its own shard, and the exempt ones are not walked', () => {
    for (const kind of OWNER_KINDS) {
      const exempt = RETENTION_EXEMPT_OWNER_KINDS.has(kind) || kind === SUMMARY_MOSAIC_OWNER_KIND
      expect(MEDIA_AUDIT_SHARD_KINDS.includes(kind)).toBe(!exempt)
    }
    for (const kind of RETIRED_OWNER_KINDS) expect(MEDIA_AUDIT_SHARD_KINDS).toContain(kind)
  })

  it('reaches a track orphan that sorts BEYOND the row ceiling of an id-ordered walk', async () => {
    // The live hub's shape, in miniature: a head of live motion rows longer
    // than the row ceiling, and the orphans behind it.
    const head: OrphanRow[] = Array.from({ length: RECLAIM.maxRowsPerScope + 1 }, (_u, i) =>
      mediaRow(`motion:${i}`, 'motion', String(i + 1)),
    )
    const tail = [
      mediaRow('track:dead-1', 'track', 'dead-1', { sizeBytes: 9_000 }),
      mediaRow('track:dead-2', 'track', 'dead-2', { sizeBytes: 1_000 }),
    ]
    const h = harness({
      rows: [...head, ...tail],
      liveEvents: { motion: head.map((_r, i) => String(i + 1)) },
    })
    const { report } = await runOrphanAudit({
      scopes: buildOrphanScopes().filter((s) => s.collection === MEDIA_COLLECTION),
      deps: h.deps,
      limits: RECLAIM,
      cursors: new Map(),
    })
    // ONE pass, from a cold cursor, reclaims the tail — which the unsharded
    // id-ordered walk could not reach in any number of passes.
    expect(h.reclaimed).toEqual(['track:dead-1', 'track:dead-2'])
    expect(report.totalBytesReclaimed).toBe(10_000)
    // And the motion shard stopping at its ceiling starved nobody.
    const motion = report.scopes.find((s) => s.shard === 'motion')
    expect(motion?.stoppedBy).toBe('row-ceiling')
  })

  it('RESUMES the starved shard where it stopped — across a respawn, from the cursors the caller persisted', async () => {
    const rows: OrphanRow[] = Array.from({ length: RECLAIM.maxRowsPerScope + 500 }, (_u, i) =>
      mediaRow(`motion:${i}`, 'motion', String(i + 1)),
    )
    // Every owner ALIVE, so nothing is deleted and the only thing that can
    // move the cursor is the walk itself.
    const liveEvents = { motion: rows.map((_r, i) => String(i + 1)) }
    const scopes = [mediaScope('motion')]
    const h = harness({ rows, liveEvents })
    const first = await runOrphanAudit({
      scopes,
      deps: h.deps,
      limits: RECLAIM,
      cursors: new Map(),
    })
    expect(first.report.scopes[0]?.stoppedBy).toBe('row-ceiling')
    expect(first.report.scopes[0]?.examined).toBe(RECLAIM.maxRowsPerScope)
    expect(first.cursors.get(scopes[0]!.id)).toBe(RECLAIM.maxRowsPerScope)

    // The respawn: a NEW engine and NEW deps, and the only thing carried over
    // is what the caller persisted. This is the case production actually runs
    // — nine respawns on the day of measurement.
    const h2 = harness({ rows, liveEvents })
    const second = await runOrphanAudit({
      scopes,
      deps: h2.deps,
      limits: RECLAIM,
      cursors: new Map(first.cursors),
    })
    // A cursor that resets would re-examine the same 20 000 rows forever. This
    // one carried, so the second pass judged the 500 the first never reached
    // and walked the shard to its END.
    expect(second.report.scopes[0]?.examined).toBe(500)
    expect(second.report.scopes[0]?.coveredWholeShard).toBe(true)
    expect(second.report.scopes[0]?.collectionSize).toBe(RECLAIM.maxRowsPerScope + 500)
  })
})

// ── 4. A cleanup deletes BYTES ───────────────────────────────────────────

describe('the reclaim confirms the blob before it forgets the row', () => {
  it('keeps the row when the unlink cannot be confirmed — an orphan is never converted into a silent leak', async () => {
    const rows = [
      mediaRow('track:stuck', 'track', 'dead-1', { sizeBytes: 50_000 }),
      mediaRow('track:gone', 'track', 'dead-2', { sizeBytes: 20_000 }),
    ]
    const h = harness({ rows, unlinkFails: ['track:stuck'] })
    const report = await auditScope(mediaScope('track'), h.deps, RECLAIM, 0)
    expect(h.reclaimed).toEqual(['track:gone'])
    expect(report.reclaimFailed).toBe(1)
    // Bytes are the ones the DELETE confirmed, never the ones it was asked for.
    expect(report.bytesReclaimed).toBe(20_000)
    // And the drop is LOUD: a branch that produces nothing says so.
    expect(
      h.logs.entries.some((r) => r.level === 'warn' && r.message.includes('reclaim failed')),
    ).toBe(true)
  })

  it('counts nothing when the delete removed no row at all', async () => {
    const h = harness({ rows: [mediaRow('track:x', 'track', 'dead-1')] })
    const deps: OrphanAuditDeps = { ...h.deps, reclaim: async () => ({ rows: 0, bytes: null }) }
    const report = await auditScope(mediaScope('track'), deps, RECLAIM, 0)
    expect(report.reclaimed).toBe(0)
    expect(report.bytesReclaimed).toBe(0)
  })
})

// ── 5. The event probe is per TABLE ──────────────────────────────────────

describe('the event liveness probe', () => {
  it('asks the table the media row NAMES — a motion id of the same number is not an answer', async () => {
    // Post-D474 truth on this hub: object ids 1–100 051 are ALL also motion
    // ids. A union probe answers "live" for every object-owned row there is.
    const rows = [mediaRow('object:7:snapshot', 'object', '7', { sizeBytes: 7_000 })]
    const h = harness({ rows, liveEvents: { motion: ['7'], object: [], audio: [] } })
    const report = await auditScope(mediaScope('object'), h.deps, RECLAIM, 0)
    expect(h.probed).toEqual([{ table: 'object', ids: ['7'] }])
    expect(report.orphans).toBe(1)
    expect(h.reclaimed).toEqual(['object:7:snapshot'])
  })

  it('keeps a row whose OWN table still holds the id', async () => {
    const rows = [mediaRow('audio:7:snapshot', 'audio', '7')]
    const h = harness({ rows, liveEvents: { audio: ['7'] } })
    const report = await auditScope(mediaScope('audio'), h.deps, RECLAIM, 0)
    expect(report.orphans).toBe(0)
    expect(h.reclaimed).toEqual([])
  })

  it('carries the table on the resolved owner ref', () => {
    expect(resolveMediaOwner(mediaRow('m', 'motion', '5'))).toEqual({
      kind: 'event',
      table: 'motion',
      eventId: '5',
    })
    expect(resolveMediaOwner(mediaRow('o', 'object', '5'))).toEqual({
      kind: 'event',
      table: 'object',
      eventId: '5',
    })
  })
})

// ── The blind spot must be visible ───────────────────────────────────────

describe('a scope says how much of its collection it covered', () => {
  it('reports the SIZE and warns when a pass did not reach the end', async () => {
    const rows: OrphanRow[] = Array.from({ length: RECLAIM.maxRowsPerScope + 1 }, (_u, i) =>
      mediaRow(`motion:${i}`, 'motion', String(i + 1)),
    )
    const h = harness({ rows, liveEvents: { motion: rows.map((_r, i) => String(i + 1)) } })
    const report = await auditScope(mediaScope('motion'), h.deps, RECLAIM, 0)
    expect(report.collectionSize).toBe(RECLAIM.maxRowsPerScope + 1)
    expect(report.coveredWholeShard).toBe(false)
    expect(
      h.logs.entries.some((r) => r.level === 'warn' && r.message.includes('did not cover')),
    ).toBe(true)
  })

  it('an unknown size is null, never 0 — a failed measurement is not an empty collection', async () => {
    const h = harness({ rows: [mediaRow('track:a', 'track', 'dead')], sizeAnswers: false })
    const report = await auditScope(mediaScope('track'), h.deps, RECLAIM, 0)
    expect(report.collectionSize).toBeNull()
    expect(report.coveredWholeShard).toBe(true)
  })

  it('WARNS when a reclaim pass freed no bytes against a standing backlog', async () => {
    const rows = [mediaRow('track:dead', 'track', 'dead-1', { sizeBytes: 500_000 })]
    const h = harness({ rows, unlinkFails: ['track:dead'] })
    const report = await auditScope(mediaScope('track'), h.deps, RECLAIM, 0)
    expect(report.orphans).toBe(1)
    expect(report.bytesReclaimed).toBe(0)
    expect(
      h.logs.entries.some((r) => r.level === 'warn' && r.message.includes('freed no bytes')),
    ).toBe(true)
  })
})
