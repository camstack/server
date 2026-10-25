/**
 * Orphan audit — ownership-keyed, report-first, and provably not an age sweep.
 *
 * The load-bearing assertions here are the negative ones. An orphan collector
 * is a delete loop pointed at the operator's own database, so these pin:
 *
 *  - report mode deletes NOTHING, ever;
 *  - an ancient row with a live owner survives (there is no clock to select on);
 *  - exempt owner kinds are refused before any probe runs;
 *  - a probe that throws abandons the scope rather than reading "dead";
 *  - an unresolvable row is counted, never deleted;
 *  - the reclaim ceiling bounds a runaway to one ceiling per run;
 *  - the cursor resumes and a page of survivors cannot wedge the scan.
 */
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { OBJECT_EVENTS_COLLECTION } from '../../store/event-store.js'
import { FACES_COLLECTION } from '../../store/face-store.js'
import {
  FACE_MEDIA_OWNER_PREFIX,
  MEDIA_COLLECTION,
  PLATE_MEDIA_OWNER_PREFIX,
} from '../../store/media-store.js'
import { PLATES_COLLECTION } from '../../store/plate-store.js'
import { TRACK_ALIASES_COLLECTION } from '../../store/track-alias-store.js'
import { ANALYTICS_COLLECTIONS, auditableCollections } from '../collection-classification.js'
import {
  auditScope,
  buildOrphanScopes,
  DEFAULT_ORPHAN_LIMITS,
  type OrphanAuditDeps,
  type OrphanAuditLimits,
  type OrphanRow,
  type OrphanScope,
  resolveDeclaredTrackOwner,
  resolveMediaOwner,
  runOrphanAudit,
} from '../orphan-audit.js'

const NOW = 10_000_000_000
const HOUR = 60 * 60 * 1000
const OLD = NOW - 90 * 24 * HOUR
const RECENT = NOW - 60 * 1000

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

/**
 * The media scope with its SHARD removed — these cases are about the engine's
 * mechanics (grace, ceilings, cursor arithmetic, probe failure), which are the
 * same whatever slice is being walked. The per-ownerKind sharding derived by
 * `buildOrphanScopes` has its own spec: `sweep-covers-the-collection.spec.ts`.
 */
const MEDIA_SCOPE: OrphanScope = {
  ...buildOrphanScopes().find((s) => s.collection === MEDIA_COLLECTION)!,
  id: MEDIA_COLLECTION,
  shard: null,
}

interface Harness {
  readonly deps: OrphanAuditDeps
  readonly reclaimed: string[]
}

function harness(input: {
  rows: readonly OrphanRow[]
  liveTracks?: readonly string[]
  liveEvents?: readonly string[]
  keptMedia?: readonly string[]
  /** Live event generations keyed by event id (D694 deviceId mismatch). */
  eventGenerations?: ReadonlyMap<string, { deviceId: number; timestamp: number }>
  trackProbeThrows?: boolean
}): Harness {
  const reclaimed: string[] = []
  const live = new Set(input.liveTracks ?? [])
  const kept = new Set(input.keptMedia ?? [])
  const liveEv = new Set(input.liveEvents ?? [])
  const remaining = (): readonly OrphanRow[] => input.rows.filter((r) => !reclaimed.includes(r.key))
  const deps: OrphanAuditDeps = {
    page: async (_collection, _shard, offset, limit) => remaining().slice(offset, offset + limit),
    size: async () => remaining().length,
    liveTrackIds: async (ids) => {
      if (input.trackProbeThrows === true) throw new Error('track store unreachable')
      return new Set(ids.filter((id) => live.has(id)))
    },
    // Per table (D480); these cases only ever ask about one, so the fake
    // answers from one set — but it must be ASKED with a table.
    liveEventIds: async (_table, ids) => new Set(ids.filter((id) => liveEv.has(id))),
    keptMediaKeys: async (keys) => new Set(keys.filter((key) => kept.has(key))),
    eventGenerations:
      input.eventGenerations === undefined
        ? undefined
        : async (_table, ids) => {
            const out = new Map<string, { deviceId: number; timestamp: number }>()
            for (const id of ids) {
              const gen = input.eventGenerations?.get(id)
              if (gen !== undefined) out.set(id, gen)
            }
            return out
          },
    reclaim: async (_collection, key, _row) => {
      reclaimed.push(key)
      const row = input.rows.find((r) => r.key === key)
      const bytes = row === undefined ? null : Number(row.data['sizeBytes'] ?? 0)
      return { rows: 1, bytes }
    },
    now: () => NOW,
    logger: makeSilentLogger(),
  }
  return { deps, reclaimed }
}

// ── Owner resolution ─────────────────────────────────────────────────────

describe('resolveMediaOwner', () => {
  it('maps every owner kind onto the entity whose existence decides its fate', () => {
    expect(resolveMediaOwner(mediaRow('a', 'track', 't-1'))).toEqual({
      kind: 'track',
      trackId: 't-1',
    })
    expect(resolveMediaOwner(mediaRow('b', 'face', `${FACE_MEDIA_OWNER_PREFIX}t-1`))).toEqual({
      kind: 'track',
      trackId: 't-1',
    })
    expect(resolveMediaOwner(mediaRow('c', 'plate', `${PLATE_MEDIA_OWNER_PREFIX}t-1`))).toEqual({
      kind: 'track',
      trackId: 't-1',
    })
    // D476: 'event' was split into 'motion' / 'object' / 'audio' — all three
    // still resolve to the generic { kind: 'event' } OwnerRef.
    expect(resolveMediaOwner(mediaRow('d', 'object', 'ev-1'))).toEqual({
      kind: 'event',
      table: 'object',
      eventId: 'ev-1',
    })
    expect(resolveMediaOwner(mediaRow('d-motion', 'motion', 'm-1'))).toEqual({
      kind: 'event',
      table: 'motion',
      eventId: 'm-1',
    })
    expect(resolveMediaOwner(mediaRow('d-audio', 'audio', 'a-1'))).toEqual({
      kind: 'event',
      table: 'audio',
      eventId: 'a-1',
    })
    expect(resolveMediaOwner(mediaRow('e', 'identity', 'i-1')).kind).toBe('exempt')
    expect(resolveMediaOwner(mediaRow('f', 'vehicle', 'v-1')).kind).toBe('exempt')
    // The group entity is DELETED (2026-09-01). Its media rows are still on
    // disk on installs that ran it, and nothing can ever claim them again —
    // so they resolve to a retired owner, not to 'unresolvable' (which would
    // leave them uncollectable forever).
    expect(resolveMediaOwner(mediaRow('g-grp', 'group', 'grp-1'))).toEqual({
      kind: 'retired-owner',
      ownerKind: 'group',
    })
    // The session summary is DELETED too (D680, 2026-09-29): its group shots
    // are the same case — no table left to ask, so reclaimable after grace.
    expect(resolveMediaOwner(mediaRow('g-sum', 'summary', 'sum-1443-1000'))).toEqual({
      kind: 'retired-owner',
      ownerKind: 'summary',
    })
  })

  it('refuses to guess when a face owner id does not carry the prefix', () => {
    expect(resolveMediaOwner(mediaRow('g', 'face', 'legacy-shape')).kind).toBe('unresolvable')
  })

  it('refuses an unknown owner kind rather than treating it as owned', () => {
    expect(resolveMediaOwner(mediaRow('h', 'something-new', 'x')).kind).toBe('unresolvable')
  })
})

describe('resolveDeclaredTrackOwner', () => {
  it('reads the declared trackId column', () => {
    expect(resolveDeclaredTrackOwner({ key: 'r', data: { trackId: 't-9' } }, false)).toEqual({
      kind: 'track',
      trackId: 't-9',
    })
  })

  it('exempts an assigned row when the collection declares enrolment', () => {
    expect(
      resolveDeclaredTrackOwner({ key: 'r', data: { trackId: 't-9', assigned: true } }, true).kind,
    ).toBe('exempt')
  })

  it('does NOT exempt an assigned row in a collection that declares no enrolment', () => {
    expect(
      resolveDeclaredTrackOwner({ key: 'r', data: { trackId: 't-9', assigned: true } }, false).kind,
    ).toBe('track')
  })
})

// ── Scope derivation ─────────────────────────────────────────────────────

describe('buildOrphanScopes', () => {
  it('derives a scope for every auditable collection — and only those', () => {
    const scopes = buildOrphanScopes()
    // One scope per auditable collection — except media, which is one scope
    // per owner kind (D480), so the COLLECTIONS covered are what must match.
    expect([...new Set(scopes.map((s) => s.collection))].toSorted()).toEqual(
      auditableCollections()
        .map((c) => c.collection)
        .toSorted(),
    )
  })

  it('covers every collection with an owner', () => {
    expect([...new Set(buildOrphanScopes().map((s) => s.collection))].toSorted()).toEqual(
      [
        OBJECT_EVENTS_COLLECTION,
        FACES_COLLECTION,
        PLATES_COLLECTION,
        MEDIA_COLLECTION,
        TRACK_ALIASES_COLLECTION,
      ].toSorted(),
    )
  })

  it('classifies every declared collection — nothing is silently unconsidered', () => {
    for (const entry of ANALYTICS_COLLECTIONS) {
      expect(entry.classification.kind, entry.collection).toBeTruthy()
    }
    // Duplicates would mean one classification silently shadowing another.
    const names = ANALYTICS_COLLECTIONS.map((c) => c.collection)
    expect(new Set(names).size).toBe(names.length)
  })
})

// ── The engine ───────────────────────────────────────────────────────────

describe('auditScope', () => {
  it('a retired SUMMARY group shot is reclaimed — there is no owner left to ask (D680)', async () => {
    const h = harness({
      rows: [mediaRow('g-old', 'summary', 'sum-1443-1000')],
    })
    const r = await auditScope(
      MEDIA_SCOPE,
      h.deps,
      { ...DEFAULT_ORPHAN_LIMITS, mode: 'reclaim' },
      0,
    )
    expect(r.orphans).toBe(1)
    expect(h.reclaimed).toEqual(['g-old'])
  })

  it('a key frame a live STATIONARY ENTRY holds survives its track (D547)', async () => {
    // The promoted track's row is gone by design — the parked object is the
    // entity, and the entity vouches for exactly one media row. The audit
    // asks the registry before it calls that row an orphan; a sibling row
    // of the same dead track is still collected.
    const h = harness({
      rows: [mediaRow('kf', 'track', 't-gone'), mediaRow('thumb', 'track', 't-gone')],
      keptMedia: ['kf'],
    })
    const r = await auditScope(MEDIA_SCOPE, h.deps, RECLAIM, 0)
    expect(r.orphans).toBe(1)
    expect(h.reclaimed).toEqual(['thumb'])
  })

  it('REPORT mode counts orphans and deletes nothing', async () => {
    const h = harness({
      rows: [mediaRow('m-dead', 'track', 't-gone')],
      liveTracks: ['t-alive'],
    })
    const r = await auditScope(MEDIA_SCOPE, h.deps, DEFAULT_ORPHAN_LIMITS, 0)
    expect(r.orphans).toBe(1)
    expect(r.reclaimed).toBe(0)
    expect(h.reclaimed).toEqual([])
    expect(r.deviceIds).toEqual([101])
  })

  it('RECLAIM mode deletes the orphan and counts its bytes', async () => {
    const h = harness({ rows: [mediaRow('m-dead', 'track', 't-gone')], liveTracks: ['t-alive'] })
    const r = await auditScope(MEDIA_SCOPE, h.deps, RECLAIM, 0)
    expect(h.reclaimed).toEqual(['m-dead'])
    expect(r.reclaimed).toBe(1)
    expect(r.bytesReclaimed).toBe(1_000)
    expect(r.stoppedBy).toBe('exhausted')
  })

  it('keeps a row whose owner is alive, however OLD it is — there is no clock here', async () => {
    const h = harness({
      rows: [mediaRow('m-ancient', 'track', 't-alive', { timestamp: 0 })],
      liveTracks: ['t-alive'],
    })
    const r = await auditScope(MEDIA_SCOPE, h.deps, RECLAIM, 0)
    expect(h.reclaimed).toEqual([])
    expect(r.examined).toBe(1)
    expect(r.orphans).toBe(0)
  })

  it('treats event-owned media on another camera as orphan when the id is reused (D694)', async () => {
    // The live holder of event id 292786 is on camera 101; leftovers from the
    // previous holder on 104 stay behind a failed lockstep delete. Id-only
    // ownership would keep them forever.
    const h = harness({
      rows: [mediaRow('leftover', 'object', '292786', { deviceId: 104 })],
      liveEvents: ['292786'],
      eventGenerations: new Map([['292786', { deviceId: 101, timestamp: OLD }]]),
    })
    const r = await auditScope(MEDIA_SCOPE, h.deps, RECLAIM, 0)
    expect(r.orphans).toBe(1)
    expect(h.reclaimed).toEqual(['leftover'])
  })

  it('does NOT reclaim on timestamp mismatch alone when the camera agrees (D694)', async () => {
    // Migrated D476 rows may not carry the event's own timestamp — reclaiming
    // on stamp alone would destroy live media. Camera match keeps them.
    const h = harness({
      rows: [mediaRow('migrated', 'object', '292786', { deviceId: 101, timestamp: OLD - 1 })],
      liveEvents: ['292786'],
      eventGenerations: new Map([['292786', { deviceId: 101, timestamp: OLD }]]),
    })
    const r = await auditScope(MEDIA_SCOPE, h.deps, RECLAIM, 0)
    expect(h.reclaimed).toEqual([])
    expect(r.orphans).toBe(0)
  })

  it('NEVER touches an exempt owner kind — even when nothing at all is alive', async () => {
    const h = harness({
      rows: [mediaRow('m-identity', 'identity', 'i-1'), mediaRow('m-vehicle', 'vehicle', 'v-1')],
      liveTracks: [],
    })
    const r = await auditScope(MEDIA_SCOPE, h.deps, RECLAIM, 0)
    expect(h.reclaimed).toEqual([])
    expect(r.exempt).toBe(2)
    expect(r.orphans).toBe(0)
  })

  it('protects a row inside the grace window even when its owner is gone', async () => {
    const h = harness({
      rows: [mediaRow('m-fresh', 'track', 't-gone', { timestamp: RECENT })],
      liveTracks: ['t-other'],
    })
    const r = await auditScope(MEDIA_SCOPE, h.deps, RECLAIM, 0)
    expect(h.reclaimed).toEqual([])
    expect(r.withinGrace).toBe(1)
    expect(r.orphans).toBe(0)
  })

  it('counts an unresolvable row and leaves it alone', async () => {
    const h = harness({ rows: [mediaRow('m-weird', 'face', 'no-prefix')], liveTracks: [] })
    const r = await auditScope(MEDIA_SCOPE, h.deps, RECLAIM, 0)
    expect(h.reclaimed).toEqual([])
    expect(r.unresolvable).toBe(1)
  })

  it('abandons the scope when a liveness probe throws — never assumes "dead"', async () => {
    const h = harness({
      rows: [mediaRow('m-1', 'track', 't-gone'), mediaRow('m-2', 'track', 't-gone')],
      trackProbeThrows: true,
    })
    const r = await auditScope(MEDIA_SCOPE, h.deps, RECLAIM, 0)
    expect(h.reclaimed).toEqual([])
    expect(r.stoppedBy).toBe('probe-failed')
  })

  it('stops at the reclaim ceiling — a runaway costs one ceiling, not a table', async () => {
    const rows = Array.from({ length: 40 }, (_v, i) => mediaRow(`m-${i}`, 'track', 't-gone'))
    const h = harness({ rows, liveTracks: ['t-alive'] })
    const r = await auditScope(
      MEDIA_SCOPE,
      h.deps,
      { ...RECLAIM, pageSize: 10, maxReclaimPerScope: 15 },
      0,
    )
    expect(r.reclaimed).toBe(15)
    expect(h.reclaimed).toHaveLength(15)
    expect(r.stoppedBy).toBe('reclaim-ceiling')
  })

  it('advances past rows it will not delete — a page of survivors cannot wedge the scan', async () => {
    const rows = [
      ...Array.from({ length: 6 }, (_v, i) => mediaRow(`keep-${i}`, 'track', 't-alive')),
      mediaRow('m-orphan', 'track', 't-gone'),
    ]
    const h = harness({ rows, liveTracks: ['t-alive'] })
    const r = await auditScope(MEDIA_SCOPE, h.deps, { ...RECLAIM, pageSize: 2 }, 0)
    expect(h.reclaimed).toEqual(['m-orphan'])
    expect(r.examined).toBe(7)
    expect(r.stoppedBy).toBe('exhausted')
  })

  it('stops at the row ceiling and RESUMES there on the next run', async () => {
    const rows = Array.from({ length: 100 }, (_v, i) => mediaRow(`keep-${i}`, 'track', 't-alive'))
    const h = harness({ rows, liveTracks: ['t-alive'] })
    const first = await auditScope(
      MEDIA_SCOPE,
      h.deps,
      { ...RECLAIM, pageSize: 10, maxRowsPerScope: 30 },
      0,
    )
    expect(first.examined).toBe(30)
    expect(first.stoppedBy).toBe('row-ceiling')
    expect(first.nextCursor).toBe(30)

    const second = await auditScope(
      MEDIA_SCOPE,
      h.deps,
      { ...RECLAIM, pageSize: 10, maxRowsPerScope: 30 },
      first.nextCursor,
    )
    expect(second.examined).toBe(30)
    expect(second.nextCursor).toBe(60)
  })

  it('resets the cursor to 0 after walking a scope to the end — the next run starts over', async () => {
    const h = harness({ rows: [mediaRow('keep', 'track', 't-alive')], liveTracks: ['t-alive'] })
    const r = await auditScope(MEDIA_SCOPE, h.deps, RECLAIM, 0)
    expect(r.nextCursor).toBe(0)
  })

  it('is idempotent — a second run over a cleaned scope reclaims nothing', async () => {
    const h = harness({ rows: [mediaRow('m-dead', 'track', 't-gone')], liveTracks: ['t-alive'] })
    await auditScope(MEDIA_SCOPE, h.deps, RECLAIM, 0)
    const second = await auditScope(MEDIA_SCOPE, h.deps, RECLAIM, 0)
    expect(second.reclaimed).toBe(0)
    expect(second.examined).toBe(0)
    expect(h.reclaimed).toEqual(['m-dead'])
  })
})

describe('runOrphanAudit', () => {
  it('reports per scope and returns the cursors the caller must persist', async () => {
    const h = harness({
      rows: [mediaRow('m-dead', 'track', 't-gone'), mediaRow('m-live', 'track', 't-alive')],
      liveTracks: ['t-alive'],
    })
    const { report, cursors } = await runOrphanAudit({
      scopes: [MEDIA_SCOPE],
      deps: h.deps,
      limits: DEFAULT_ORPHAN_LIMITS,
      cursors: new Map(),
    })
    expect(report.mode).toBe('report')
    expect(report.totalOrphans).toBe(1)
    expect(report.totalReclaimed).toBe(0)
    expect(report.scopes).toHaveLength(1)
    expect(report.scopes[0]?.collection).toBe(MEDIA_COLLECTION)
    expect(cursors.get(MEDIA_SCOPE.id)).toBe(0)
  })

  it('defaults to report mode — reclaiming is never the accident', () => {
    expect(DEFAULT_ORPHAN_LIMITS.mode).toBe('report')
  })
})
