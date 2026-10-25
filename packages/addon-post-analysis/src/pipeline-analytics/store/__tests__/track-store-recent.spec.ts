/**
 * TrackStore.queryRecent (pipelineAnalytics.listRecentTracks) — batched
 * multi-device listing + slim projection on queryHistorical (listTracks).
 *
 * Covers:
 *  - multi-device merge ordered by (lastSeen DESC, trackId DESC)
 *  - cursor stability across pages: concatenated pages reproduce the full
 *    sorted set exactly once (including same-millisecond ties straddling a
 *    page boundary), final page ends with nextCursor null
 *  - since/until window on lastSeen
 *  - slim projection shape (positions/snapshots emptied, scalars + envelope
 *    kept) on both queryRecent and queryHistorical
 *  - empty deviceIds / duplicate deviceIds / malformed cursor
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  makeFakeSettingsStore,
  makeSilentLogger,
  type FakeSettingsStore,
} from '../../__tests__/test-helpers.js'
import { compareRecentDesc, decodeRecentCursor, encodeRecentCursor } from '../recent-cursor.js'
import { RECENT_FANOUT_ROW_BUDGET, TrackStore, TRACKS_COLLECTION } from '../track-store.js'

const posRow = (cx: number, cy: number, timestamp: number) => ({
  x: cx,
  y: cy,
  timestamp,
  bbox: { x: cx - 5, y: cy - 5, w: 10, h: 10 },
})

const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  deviceId: 1,
  className: 'person',
  firstSeen: 1000,
  lastSeen: 1500,
  positions: [posRow(50, 50, 1000)],
  snapshots: [{ timestamp: 1000, position: posRow(50, 50, 1000), mediaId: 'm1' }],
  zonesVisited: ['garden'],
  classes: ['person'],
  totalDistance: 0.5,
  state: 'idle',
  importance: 0.7,
  bestEventId: 'ev-1',
  importanceReason: 'dwell',
  audioLabels: [{ label: 'speech', peakScore: 0.9, count: 2, firstAt: 1000, lastAt: 1400 }],
  envMinX: 0.1,
  envMinY: 0.2,
  envMaxX: 0.3,
  envMaxY: 0.4,
  frameWidth: 100,
  frameHeight: 100,
  ...over,
})

describe('TrackStore.queryRecent', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(() => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
  })

  it('merges multiple devices ordered by lastSeen DESC with trackId DESC tie-break', async () => {
    fake.seed(TRACKS_COLLECTION, [
      { id: 'a1', data: row({ deviceId: 1, lastSeen: 100 }) },
      { id: 'b1', data: row({ deviceId: 2, lastSeen: 300 }) },
      { id: 'a2', data: row({ deviceId: 1, lastSeen: 200 }) },
      // Same-ms tie across devices → id DESC decides.
      { id: 'c-z', data: row({ deviceId: 3, lastSeen: 200 }) },
    ])
    const page = await store.queryRecent({ deviceIds: [1, 2, 3] })
    expect(page.tracks.map((t) => t.trackId)).toEqual(['b1', 'c-z', 'a2', 'a1'])
    expect(page.nextCursor).toBeNull()
  })

  it('excludes devices that were not requested', async () => {
    fake.seed(TRACKS_COLLECTION, [
      { id: 'want', data: row({ deviceId: 1, lastSeen: 100 }) },
      { id: 'skip', data: row({ deviceId: 9, lastSeen: 200 }) },
    ])
    const page = await store.queryRecent({ deviceIds: [1] })
    expect(page.tracks.map((t) => t.trackId)).toEqual(['want'])
  })

  it('pages with a stable cursor: concatenation covers every row exactly once, ties included', async () => {
    // 23 rows over 3 devices; a 4-row same-ms tie cluster at lastSeen 5000
    // engineered to straddle a page boundary.
    const seeded: Array<{ id: string; data: Record<string, unknown> }> = []
    for (let i = 0; i < 19; i++) {
      seeded.push({
        id: `t-${String(i).padStart(2, '0')}`,
        data: row({ deviceId: (i % 3) + 1, lastSeen: 10_000 - i * 137 }),
      })
    }
    for (const id of ['tie-a', 'tie-b', 'tie-c', 'tie-d']) {
      seeded.push({ id, data: row({ deviceId: 2, lastSeen: 5000 }) })
    }
    fake.seed(TRACKS_COLLECTION, seeded)

    const expected = seeded
      .map((r) => ({ id: r.id, lastSeen: r.data['lastSeen'] as number }))
      .sort(compareRecentDesc)
      .map((r) => r.id)

    const collected: string[] = []
    let cursor: string | undefined
    let pages = 0
    for (;;) {
      const page = await store.queryRecent({
        deviceIds: [1, 2, 3],
        limit: 5,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      collected.push(...page.tracks.map((t) => t.trackId))
      pages++
      if (page.nextCursor === null) break
      cursor = page.nextCursor
      expect(pages).toBeLessThan(20) // safety against a cursor loop
    }
    expect(collected).toEqual(expected)
    expect(pages).toBe(Math.ceil(seeded.length / 5))
  })

  it('re-running a page with the same cursor yields identical results', async () => {
    fake.seed(
      TRACKS_COLLECTION,
      Array.from({ length: 8 }, (_, i) => ({
        id: `t${i}`,
        data: row({ deviceId: 1, lastSeen: 1000 + i }),
      })),
    )
    const first = await store.queryRecent({ deviceIds: [1], limit: 3 })
    expect(first.nextCursor).not.toBeNull()
    const again = await store.queryRecent({ deviceIds: [1], limit: 3 })
    expect(again).toEqual(first)
    const second = await store.queryRecent({ deviceIds: [1], limit: 3, cursor: first.nextCursor! })
    const secondAgain = await store.queryRecent({
      deviceIds: [1],
      limit: 3,
      cursor: first.nextCursor!,
    })
    expect(secondAgain).toEqual(second)
    expect(second.tracks[0]!.trackId).not.toBe(first.tracks[2]!.trackId)
  })

  it('final full page ends with nextCursor null (no empty trailing page)', async () => {
    fake.seed(
      TRACKS_COLLECTION,
      Array.from({ length: 6 }, (_, i) => ({
        id: `t${i}`,
        data: row({ deviceId: 1, lastSeen: 1000 + i }),
      })),
    )
    const p1 = await store.queryRecent({ deviceIds: [1], limit: 3 })
    expect(p1.tracks).toHaveLength(3)
    expect(p1.nextCursor).not.toBeNull()
    const p2 = await store.queryRecent({ deviceIds: [1], limit: 3, cursor: p1.nextCursor! })
    expect(p2.tracks).toHaveLength(3)
    expect(p2.nextCursor).toBeNull()
  })

  it('applies the since/until window on lastSeen (inclusive)', async () => {
    fake.seed(TRACKS_COLLECTION, [
      { id: 'old', data: row({ deviceId: 1, lastSeen: 100 }) },
      { id: 'lo', data: row({ deviceId: 1, lastSeen: 200 }) },
      { id: 'mid', data: row({ deviceId: 1, lastSeen: 300 }) },
      { id: 'hi', data: row({ deviceId: 1, lastSeen: 400 }) },
      { id: 'new', data: row({ deviceId: 1, lastSeen: 500 }) },
    ])
    const page = await store.queryRecent({ deviceIds: [1], since: 200, until: 400 })
    expect(page.tracks.map((t) => t.trackId)).toEqual(['hi', 'mid', 'lo'])
  })

  it('until below a cursor lastSeen still pages correctly', async () => {
    fake.seed(TRACKS_COLLECTION, [
      { id: 'a', data: row({ deviceId: 1, lastSeen: 100 }) },
      { id: 'b', data: row({ deviceId: 1, lastSeen: 200 }) },
    ])
    // Cursor at lastSeen 900 (above the until bound) → single-range path.
    const cursor = encodeRecentCursor({ lastSeen: 900, trackId: 'zzz' })
    const page = await store.queryRecent({ deviceIds: [1], until: 250, cursor })
    expect(page.tracks.map((t) => t.trackId)).toEqual(['b', 'a'])
  })

  it('returns an empty page for an empty deviceIds array', async () => {
    fake.seed(TRACKS_COLLECTION, [{ id: 't1', data: row({ deviceId: 1 }) }])
    const page = await store.queryRecent({ deviceIds: [] })
    expect(page).toEqual({ tracks: [], nextCursor: null })
  })

  it('dedupes repeated deviceIds (no duplicate rows)', async () => {
    fake.seed(TRACKS_COLLECTION, [{ id: 't1', data: row({ deviceId: 1 }) }])
    const page = await store.queryRecent({ deviceIds: [1, 1, 1] })
    expect(page.tracks.map((t) => t.trackId)).toEqual(['t1'])
  })

  it('rejects a malformed cursor', async () => {
    await expect(store.queryRecent({ deviceIds: [1], cursor: 'not-a-cursor!!' })).rejects.toThrow(
      /malformed cursor/,
    )
  })

  it('slim projection empties positions/snapshots but keeps scalars + envelope', async () => {
    fake.seed(TRACKS_COLLECTION, [{ id: 't1', data: row({ deviceId: 1 }) }])
    const page = await store.queryRecent({ deviceIds: [1], projection: 'slim' })
    expect(page.tracks).toHaveLength(1)
    const t = page.tracks[0]!
    expect(t.positions).toEqual([])
    expect(t.snapshots).toEqual([])
    expect(t.trackId).toBe('t1')
    expect(t.deviceId).toBe(1)
    expect(t.className).toBe('person')
    expect(t.classes).toEqual(['person'])
    expect(t.firstSeen).toBe(1000)
    expect(t.lastSeen).toBe(1500)
    expect(t.state).toBe('idle')
    expect(t.active).toBe(false)
    expect(t.zonesVisited).toEqual(['garden'])
    expect(t.importance).toBe(0.7)
    expect(t.importanceReason).toBe('dwell')
    expect(t.bestEventId).toBe('ev-1')
    expect(t.audioLabels).toEqual([
      { label: 'speech', peakScore: 0.9, count: 2, firstAt: 1000, lastAt: 1400 },
    ])
    expect(t.envelope).toEqual({ minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4 })
  })

  it('full projection (default) keeps positions/snapshots and adds envelope', async () => {
    fake.seed(TRACKS_COLLECTION, [{ id: 't1', data: row({ deviceId: 1 }) }])
    const page = await store.queryRecent({ deviceIds: [1] })
    const t = page.tracks[0]!
    expect(t.positions).toHaveLength(1)
    expect(t.snapshots).toHaveLength(1)
    expect(t.envelope).toEqual({ minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4 })
  })

  it('omits envelope when the persisted columns are absent (legacy row)', async () => {
    const legacy = row({ deviceId: 1 })
    delete legacy['envMinX']
    delete legacy['envMinY']
    delete legacy['envMaxX']
    delete legacy['envMaxY']
    fake.seed(TRACKS_COLLECTION, [{ id: 't1', data: legacy }])
    const page = await store.queryRecent({ deviceIds: [1] })
    expect(page.tracks[0]!.envelope).toBeUndefined()
  })
})

describe('TrackStore.queryHistorical projection (listTracks)', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(() => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
  })

  it('slim drops positions/snapshots, full stays byte-compatible', async () => {
    fake.seed(TRACKS_COLLECTION, [{ id: 't1', data: row({ deviceId: 4 }) }])
    const slim = await store.queryHistorical({ deviceId: 4, projection: 'slim' })
    expect(slim[0]!.positions).toEqual([])
    expect(slim[0]!.snapshots).toEqual([])
    expect(slim[0]!.zonesVisited).toEqual(['garden'])
    const full = await store.queryHistorical({ deviceId: 4 })
    expect(full[0]!.positions).toHaveLength(1)
    expect(full[0]!.snapshots).toHaveLength(1)
  })

  it('zone + slim: the precise per-position test still runs before the drop', async () => {
    fake.seed(TRACKS_COLLECTION, [
      // Positions inside the zone (envelope overlapping) → match.
      {
        id: 't-in',
        data: row({
          deviceId: 4,
          positions: [posRow(50, 50, 1000)],
          envMinX: 0.45,
          envMinY: 0.45,
          envMaxX: 0.55,
          envMaxY: 0.55,
        }),
      },
      // Envelope overlaps but positions never touch the zone → rejected.
      {
        id: 't-out',
        data: row({
          deviceId: 4,
          positions: [posRow(90, 90, 1000)],
          envMinX: 0,
          envMinY: 0,
          envMaxX: 1,
          envMaxY: 1,
        }),
      },
    ])
    const result = await store.queryHistorical({
      deviceId: 4,
      zone: { kind: 'rect', x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      projection: 'slim',
    })
    expect(result.map((t) => t.trackId)).toEqual(['t-in'])
    expect(result[0]!.positions).toEqual([])
  })
})

describe('stationary-promotion exclusion (the 2026-08-15 events-feed regression)', () => {
  // e5fb7dc50 made a parked subject's track PERSIST (closedReason:
  // 'stationary-promotion') instead of vanishing, and every default read path
  // suddenly listed parking records as passages. The store keeps them visible
  // by DEFAULT (retention/forensics must), and the facade opts the feed out.
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(() => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
  })

  it('queryRecent keeps stationary rows by DEFAULT (store is honest for internal readers)', async () => {
    fake.seed(TRACKS_COLLECTION, [
      { id: 'passage', data: row({ deviceId: 1, lastSeen: 200 }) },
      {
        id: 'parked',
        data: row({ deviceId: 1, lastSeen: 300, closedReason: 'stationary-promotion' }),
      },
    ])
    const page = await store.queryRecent({ deviceIds: [1] })
    expect(page.tracks.map((t) => t.trackId).sort()).toEqual(['parked', 'passage'])
  })

  it('queryRecent excludes them on demand — and never drops rows with NO closedReason', async () => {
    fake.seed(TRACKS_COLLECTION, [
      { id: 'passage', data: row({ deviceId: 1, lastSeen: 200 }) },
      {
        id: 'parked',
        data: row({ deviceId: 1, lastSeen: 300, closedReason: 'stationary-promotion' }),
      },
    ])
    const page = await store.queryRecent({ deviceIds: [1], excludeStationaryPromotions: true })
    expect(page.tracks.map((t) => t.trackId)).toEqual(['passage'])
  })

  it('queryHistorical applies the same exclusion on both its plain and zone paths', async () => {
    fake.seed(TRACKS_COLLECTION, [
      { id: 'passage', data: row({ deviceId: 1, firstSeen: 1000, lastSeen: 1500 }) },
      {
        id: 'parked',
        data: row({
          deviceId: 1,
          firstSeen: 1100,
          lastSeen: 1600,
          closedReason: 'stationary-promotion',
        }),
      },
    ])
    const plain = await store.queryHistorical({ deviceId: 1, excludeStationaryPromotions: true })
    expect(plain.map((t) => t.trackId)).toEqual(['passage'])
    const zoned = await store.queryHistorical({
      deviceId: 1,
      zone: { kind: 'rect', x: 0, y: 0, width: 1, height: 1 },
      excludeStationaryPromotions: true,
    })
    expect(zoned.map((t) => t.trackId)).toEqual(['passage'])
    // And the default still returns both.
    const all = await store.queryHistorical({ deviceId: 1 })
    expect(all.map((t) => t.trackId).sort()).toEqual(['parked', 'passage'])
  })
})

describe('recent-cursor helpers', () => {
  it('round-trips a cursor', () => {
    const c = { lastSeen: 1234567890123, trackId: 'dev-1:track-42' }
    expect(decodeRecentCursor(encodeRecentCursor(c))).toEqual(c)
  })

  it('rejects malformed payloads', () => {
    const bad = Buffer.from(JSON.stringify({ l: 'nope', i: 5 }), 'utf8').toString('base64url')
    expect(() => decodeRecentCursor(bad)).toThrow(/malformed cursor/)
    expect(() => decodeRecentCursor('%%%')).toThrow(/malformed cursor/)
  })
})

/**
 * The fan-out budget.
 *
 * `queryRecent` fetches `limit + 1` FULL rows PER DEVICE so the k-way merge is
 * correct, then returns `limit` of them. The row count it makes the settings
 * engine materialise is therefore `deviceCount x (limit + 1)`, and nothing
 * bounded `deviceCount`.
 *
 * On 2026-08-07 a viewer resumed and asked for a 12-hour window over 16
 * cameras with limit 960 — TWICE, 33 ms apart. That is ~32 000 track rows, on
 * a table whose `positions` column averages 10 KB per row, all live in hub-main
 * at once. It reached the 4 288 MB heap limit; the fatal Mark-Compact reclaimed
 * 4 MB of 4 090, i.e. every byte was still reachable. `Statement::JS_all` was
 * where the wall was hit, not the size of any one call.
 *
 * The budget is on the PRODUCT. Nothing is lost: the page shrinks and the
 * client follows `nextCursor`, which is the paging contract it already uses.
 */
describe('TrackStore.queryRecent — fan-out budget', () => {
  let fake: FakeSettingsStore
  let store: TrackStore
  let issuedLimits: Array<number | undefined>

  beforeEach(() => {
    fake = makeFakeSettingsStore()
    issuedLimits = []
    const spied = {
      ...fake.client,
      query: {
        query: async (input: Parameters<FakeSettingsStore['client']['query']['query']>[0]) => {
          issuedLimits.push(input.filter?.limit)
          return fake.client.query.query(input)
        },
      },
    } as FakeSettingsStore['client']
    store = new TrackStore({ store: spied, logger: makeSilentLogger() })
  })

  function seedAcross(deviceIds: readonly number[], perDevice: number) {
    fake.seed(
      TRACKS_COLLECTION,
      deviceIds.flatMap((d) =>
        Array.from({ length: perDevice }, (_, i) => ({
          id: `d${d}-t${String(i).padStart(4, '0')}`,
          data: row({ deviceId: d, lastSeen: 1_000_000 - i }),
        })),
      ),
    )
  }

  it('bounds deviceCount x limit, not just limit', async () => {
    const deviceIds = Array.from({ length: 16 }, (_, i) => 600 + i)
    seedAcross(deviceIds, 5)
    await store.queryRecent({ deviceIds, limit: 960 })
    const totalRequested = issuedLimits.reduce<number>((sum, l) => sum + (l ?? 0), 0)
    expect(
      totalRequested,
      'the fan-out is what materialised ~32 000 rows in hub-main',
    ).toBeLessThanOrEqual(RECENT_FANOUT_ROW_BUDGET + deviceIds.length)
  })

  it('leaves a single-device request untouched', async () => {
    seedAcross([101], 5)
    await store.queryRecent({ deviceIds: [101], limit: 300 })
    expect(issuedLimits).toEqual([301])
  })

  it('still returns a full, correctly ordered page under the budget', async () => {
    const deviceIds = Array.from({ length: 16 }, (_, i) => 600 + i)
    seedAcross(deviceIds, 40)
    const page = await store.queryRecent({ deviceIds, limit: 960 })
    // Shrunk to the per-device budget share, not 960 — and a cursor is offered.
    expect(page.tracks.length).toBeGreaterThan(0)
    expect(page.tracks.length).toBeLessThan(960)
    expect(page.nextCursor).not.toBeNull()
    const lastSeen = page.tracks.map((t) => t.lastSeen)
    expect([...lastSeen].sort((a, b) => b - a)).toEqual(lastSeen)
  })

  it('pages the whole set through the cursor without loss or duplication', async () => {
    const deviceIds = [601, 602, 603, 604]
    seedAcross(deviceIds, 30) // 120 tracks total
    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 50; i++) {
      const page: Awaited<ReturnType<TrackStore['queryRecent']>> = await store.queryRecent({
        deviceIds,
        limit: 1000,
        ...(cursor !== null ? { cursor } : {}),
      })
      seen.push(...page.tracks.map((t) => t.trackId))
      cursor = page.nextCursor
      if (cursor === null) break
    }
    expect(seen).toHaveLength(120)
    expect(new Set(seen).size).toBe(120)
  })
})
