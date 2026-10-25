/**
 * The orphan audit's faces / plates / track-aliases scopes on a RECORDS hub.
 *
 * There the legacy `pipeline-analytics:faces` / `:plates` / `:track-aliases`
 * tables are dropped, and the backend refuses any verb on an undeclared
 * collection. The settings store below refuses them the same way, so a scope
 * that still pages, counts or deletes by collection name fails here exactly as
 * it failed on the hub every pass. The rows live only in the records kinds,
 * reached through the ports production wires (`orphan-audit-ledgers.ts`).
 *
 * Disarm (restored byte-identical): `orphanAuditLedgers` answering an empty
 * map (the pre-fix wiring — every collection paged by name) turns every case
 * red with "is not declared".
 */
import type { SettingsStoreClient } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeFakeRecords } from '../../__tests__/fake-records.js'
import { makeFakeSettingsStore, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { pipelineAnalyticsRecordKinds } from '../../record-kinds.js'
import { wirePlateLedger } from '../../store/event-ledger-wiring.js'
import { FACES_COLLECTION } from '../../store/face-store.js'
import { PLATES_COLLECTION } from '../../store/plate-store.js'
import { TRACK_ALIASES_COLLECTION } from '../../store/track-alias-store.js'
import {
  auditScope,
  buildOrphanScopes,
  DEFAULT_ORPHAN_LIMITS,
  type OrphanAuditDeps,
  type OrphanScope,
} from '../orphan-audit.js'
import { auditCollectionPorts, orphanAuditLedgers, plateDeleter } from '../orphan-audit-ledgers.js'
import { buildOrphanReclaimer } from '../orphan-reclaimers.js'

const NOW = 10_000_000_000
const OLD = NOW - 90 * 24 * 60 * 60 * 1000
const DROPPED = new Set([FACES_COLLECTION, PLATES_COLLECTION, TRACK_ALIASES_COLLECTION])

/** What a migrated hub's backend does to a dropped table: refuse every verb. */
function refuseDroppedTables(client: SettingsStoreClient): void {
  const refuse = (collection: string): void => {
    if (DROPPED.has(collection)) throw new Error(`collection "${collection}" is not declared`)
  }
  const query = client.query.query.bind(client.query)
  vi.spyOn(client.query, 'query').mockImplementation(async (input) => {
    refuse(input.collection)
    return query(input)
  })
  const count = client.count.query.bind(client.count)
  vi.spyOn(client.count, 'query').mockImplementation(async (input) => {
    refuse(input.collection)
    return count(input)
  })
  const get = client.get.query.bind(client.get)
  vi.spyOn(client.get, 'query').mockImplementation(async (input) => {
    refuse(input.collection)
    return get(input)
  })
  const del = client.delete.mutate.bind(client.delete)
  vi.spyOn(client.delete, 'mutate').mockImplementation(async (input) => {
    refuse(input.collection)
    return del(input)
  })
  const deleteWhere = client.deleteWhere.mutate.bind(client.deleteWhere)
  vi.spyOn(client.deleteWhere, 'mutate').mockImplementation(async (input) => {
    refuse(input.collection)
    return deleteWhere(input)
  })
}

function scopeOf(collection: string): OrphanScope {
  const scope = buildOrphanScopes().find((s) => s.collection === collection)
  if (scope === undefined) throw new Error(`${collection} is not an audited collection`)
  return scope
}

async function recordsHub(plates: number) {
  const fake = makeFakeSettingsStore()
  refuseDroppedTables(fake.client)
  const records = makeFakeRecords()
  await records.records.declare(pipelineAnalyticsRecordKinds)
  for (let i = 0; i < plates; i++) {
    const id = `plate-${String(i).padStart(3, '0')}`
    // Every third plate's track is still alive: the walk must step over it
    // and keep going — through the KEYSET, which a reclaim never shifts.
    const trackId = i % 3 === 0 ? `live-${i}` : `dead-${i}`
    records.seed('plates', {
      id,
      deviceId: 101,
      at: OLD,
      data: { trackId, plateText: `AB${i}`, assigned: false },
    })
  }
  for (let i = 0; i < 4; i++) {
    records.seed('faces', {
      id: `face-${i}`,
      deviceId: 101,
      at: OLD,
      data: { trackId: `dead-face-${i}`, assigned: false },
    })
  }
  const wiring = { store: fake.client, records: records.records }
  const ledgers = orphanAuditLedgers(wiring)
  const ports = auditCollectionPorts(fake.client, ledgers)
  const deletedFaces: string[] = []
  const deps: OrphanAuditDeps = {
    pageKeyset: ports.pageKeyset,
    page: async (collection, _shard, offset, limit) =>
      ports.pageByOffset(collection, offset, limit),
    size: async (collection) => ports.size(collection),
    liveTrackIds: async (ids) => new Set(ids.filter((id) => id.startsWith('live-'))),
    liveEventIds: async () => new Set<string>(),
    reclaim: (collection, key, row) =>
      buildOrphanReclaimer({
        deleteFace: async (faceId) => {
          deletedFaces.push(faceId)
        },
        deleteMediaConfirmed: async () => {
          throw new Error('not media')
        },
        deleteTrackAlias: async () => {
          throw new Error('not an alias')
        },
        deletePlate: plateDeleter(wirePlateLedger(wiring), makeSilentLogger()),
        deleteRow: async () => {
          throw new Error('no raw delete on this scope')
        },
        logger: makeSilentLogger(),
      })(collection, key, row.data),
    now: () => NOW,
    logger: makeSilentLogger(),
  }
  return { records, deps, deletedFaces }
}

const plateIds = (records: ReturnType<typeof makeFakeRecords>): string[] =>
  [...(records.tables.get('plates')?.keys() ?? [])].toSorted()

describe('orphan audit — records-backed scopes on a hub whose legacy tables are dropped', () => {
  it('pages, counts and reclaims plates through the plates kind, in bounded keyset pages', async () => {
    const h = await recordsHub(12)
    const report = await auditScope(
      scopeOf(PLATES_COLLECTION),
      h.deps,
      { ...DEFAULT_ORPHAN_LIMITS, mode: 'reclaim', pageSize: 5 },
      0,
    )
    expect(report.stoppedBy).toBe('exhausted')
    expect(report.collectionSize).toBe(12)
    // Every row judged once although 8 were deleted mid-walk: a keyset
    // resumes after the last row READ, so nothing behind it shifts.
    expect(report.examined).toBe(12)
    expect(report.orphans).toBe(8)
    expect(report.reclaimed).toBe(8)
    expect(report.nextCursor).toBe(0)
    expect(plateIds(h.records)).toEqual(['plate-000', 'plate-003', 'plate-006', 'plate-009'])
  })

  it('resumes from the opaque cursor it persisted, and from the top after the end', async () => {
    const h = await recordsHub(12)
    const limits = {
      ...DEFAULT_ORPHAN_LIMITS,
      mode: 'report' as const,
      pageSize: 5,
      maxRowsPerScope: 5,
    }
    const first = await auditScope(scopeOf(PLATES_COLLECTION), h.deps, limits, 0)
    expect(first.stoppedBy).toBe('row-ceiling')
    expect(typeof first.nextCursor).toBe('string')
    const second = await auditScope(scopeOf(PLATES_COLLECTION), h.deps, limits, first.nextCursor)
    const third = await auditScope(scopeOf(PLATES_COLLECTION), h.deps, limits, second.nextCursor)
    expect([first.examined, second.examined, third.examined]).toEqual([5, 5, 2])
    expect(third.stoppedBy).toBe('exhausted')
    expect(third.nextCursor).toBe(0)
    // An offset persisted before the scope moved onto records means nothing
    // to the keyset: it starts from the top, never skips.
    const stale = await auditScope(scopeOf(PLATES_COLLECTION), h.deps, limits, 20_000)
    expect(stale.examined).toBe(5)
  })

  it('a reclaim ceiling resumes at the page it stopped in, and the next run finishes it', async () => {
    const h = await recordsHub(12)
    const limits = {
      ...DEFAULT_ORPHAN_LIMITS,
      mode: 'reclaim' as const,
      pageSize: 5,
      maxReclaimPerScope: 3,
    }
    const first = await auditScope(scopeOf(PLATES_COLLECTION), h.deps, limits, 0)
    expect(first.stoppedBy).toBe('reclaim-ceiling')
    expect(first.reclaimed).toBe(3)
    const second = await auditScope(scopeOf(PLATES_COLLECTION), h.deps, limits, first.nextCursor)
    const third = await auditScope(scopeOf(PLATES_COLLECTION), h.deps, limits, second.nextCursor)
    expect(first.reclaimed + second.reclaimed + third.reclaimed).toBe(8)
    expect(plateIds(h.records)).toEqual(['plate-000', 'plate-003', 'plate-006', 'plate-009'])
  })

  it('walks faces through the faces kind and reclaims through the owner', async () => {
    const h = await recordsHub(0)
    const report = await auditScope(
      scopeOf(FACES_COLLECTION),
      h.deps,
      { ...DEFAULT_ORPHAN_LIMITS, mode: 'reclaim', pageSize: 3 },
      0,
    )
    expect(report.stoppedBy).toBe('exhausted')
    expect(report.collectionSize).toBe(4)
    expect(report.examined).toBe(4)
    expect(h.deletedFaces.toSorted()).toEqual(['face-0', 'face-1', 'face-2', 'face-3'])
  })

  it('stops between pages when asked, keeping its cursor', async () => {
    const h = await recordsHub(12)
    let pages = 0
    const report = await auditScope(
      scopeOf(PLATES_COLLECTION),
      {
        ...h.deps,
        stop: () => pages >= 1,
        pageKeyset: async (c, cursor, limit) => {
          pages += 1
          return h.deps.pageKeyset!(c, cursor, limit)
        },
      },
      { ...DEFAULT_ORPHAN_LIMITS, mode: 'report', pageSize: 5 },
      0,
    )
    expect(report.stoppedBy).toBe('stopped')
    expect(report.examined).toBe(5)
    expect(typeof report.nextCursor).toBe('string')
  })
})
