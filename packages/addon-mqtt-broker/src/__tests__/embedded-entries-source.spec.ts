import { describe, expect, it } from 'vitest'
import {
  allRecordIds,
  copyIsRecorded,
  type EmbeddedEntries,
  resolveEmbeddedEntries,
} from '../embedded-entries-source.js'
import { parseLegacyClientsAcl } from '../migrations/clients-acl-to-records.js'

const NONE: EmbeddedEntries = { clients: [], acl: [] }
const LEGACY = parseLegacyClientsAcl({
  embeddedClients: [{ username: 'legacy', passwordHash: '$2b$10$h' }],
  embeddedAcl: [{ username: 'legacy', topicPattern: 'x/#', access: 'both' }],
})
const NO_IDS = { clients: new Set<string>(), acl: new Set<string>() }

describe('resolveEmbeddedEntries', () => {
  it('serves the legacy lists while the copy is not recorded and the records are empty', async () => {
    const r = await resolveEmbeddedEntries({
      copyRecorded: false,
      fromRecords: NONE,
      readLegacy: async () => LEGACY,
      readRecordIds: async () => NO_IDS,
    })
    expect(r).toMatchObject({ kind: 'ready' })
    if (r.kind === 'ready') {
      expect(r.entries.clients.map((c) => c.username)).toEqual(['legacy'])
      expect(r.entries.acl).toHaveLength(1)
    }
  })

  it('keeps a switched-off record off: a legacy twin is not added back', async () => {
    const r = await resolveEmbeddedEntries({
      copyRecorded: false,
      fromRecords: NONE,
      readLegacy: async () => LEGACY,
      readRecordIds: async () => ({
        clients: new Set(['legacy']),
        acl: new Set(['legacy\u0000x/#']),
      }),
    })
    expect(r).toMatchObject({ kind: 'ready', entries: NONE })
  })

  it('fails closed when the copy is not recorded and the legacy lists cannot be read', async () => {
    const r = await resolveEmbeddedEntries({
      copyRecorded: false,
      fromRecords: NONE,
      readLegacy: async () => {
        throw new Error('settings store down')
      },
      readRecordIds: async () => NO_IDS,
    })
    expect(r).toEqual({ kind: 'unavailable', reason: 'settings store down' })
  })

  it('reads the records alone once the copy was applied, never touching the lists', async () => {
    const r = await resolveEmbeddedEntries({
      copyRecorded: true,
      fromRecords: NONE,
      readLegacy: async () => {
        throw new Error('must not be read')
      },
      readRecordIds: async () => NO_IDS,
    })
    expect(r).toMatchObject({ kind: 'ready', entries: NONE })
  })
})

describe('copyIsRecorded', () => {
  const report = { declared: true, applied: ['a'], failed: [] as string[] }
  it('is true only for a migration applied by this run', () => {
    expect(copyIsRecorded(report, 'a')).toBe(true)
    expect(copyIsRecorded(report, 'b')).toBe(false)
    expect(copyIsRecorded({ ...report, declared: false }, 'a')).toBe(false)
    expect(copyIsRecorded({ ...report, failed: ['a'] }, 'a')).toBe(false)
  })
})

describe('allRecordIds', () => {
  it('pages until the cursor is exhausted', async () => {
    const pages = [
      { records: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c1' },
      { records: [{ id: 'c' }], nextCursor: 'c2' },
      { records: [{ id: 'd' }], nextCursor: null },
    ]
    const seen: (string | undefined)[] = []
    const ids = await allRecordIds({
      query: async (q) => {
        seen.push(q.cursor)
        return pages[seen.length - 1] ?? { records: [], nextCursor: null }
      },
    })
    expect([...ids]).toEqual(['a', 'b', 'c', 'd'])
    expect(seen).toEqual([undefined, 'c1', 'c2'])
  })
})
