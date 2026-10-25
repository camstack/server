import { FACE_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import { describe, it, expect, beforeEach } from 'vitest'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import {
  FaceStore,
  FACE_SWEEP_PAGE,
  FACE_WINDOW_MAX_ROWS,
  type FaceRecord,
} from '../store/face-store.js'
import {
  type AnalyticsLedgers,
  type FakeRecords,
  makeAnalyticsWorld,
  seedLedgerRows,
} from './fake-records.js'
import { makeFakeEmbeddingIndex, makeSilentLogger } from './test-helpers.js'

interface FaceWorld {
  readonly world: FakeRecords
  readonly ledgers: AnalyticsLedgers
  readonly store: FaceStore
}

/** A `FaceStore` over a fresh records world, wired as `index.ts` wires it. */
async function makeFaceWorld(logger: IScopedLogger = makeSilentLogger()): Promise<FaceWorld> {
  const { world, ledgers } = await makeAnalyticsWorld()
  const store = new FaceStore({
    vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
    logger,
    faceLedger: ledgers.faces,
  })
  return { world, ledgers, store }
}

function faceRecord(
  id: string,
  deviceId: number,
  trackId: string,
  ts: number,
  assigned = false,
): FaceRecord {
  return {
    id,
    deviceId,
    trackId,
    timestamp: ts,
    embedding: [0.1, 0.2],
    mediaId: ts,
    assigned,
  }
}

function suggested(id: string, deviceId: number, ts: number): FaceRecord {
  return {
    ...faceRecord(id, deviceId, id, ts),
    suggestedIdentityId: 'identity-1',
    suggestedMatchScore: 0.41,
  }
}

interface CapturedWarn {
  readonly message: string
  readonly extras?: LogExtras
}

interface LogCapture {
  readonly logger: IScopedLogger
  readonly warns: CapturedWarn[]
}

function makeLogCapture(): LogCapture {
  const warns: CapturedWarn[] = []
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: (message: string, extras?: LogExtras): void => {
      warns.push({ message, ...(extras !== undefined ? { extras } : {}) })
    },
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, warns }
}

describe('FaceStore', () => {
  let ledgers: AnalyticsLedgers
  let store: FaceStore

  beforeEach(async () => {
    ;({ ledgers, store } = await makeFaceWorld())
  })

  it('insert is upsert-by-id (one entry per track)', async () => {
    await store.insert(faceRecord('t1', 7, 't1', 1000))
    await store.insert(faceRecord('t1', 7, 't1', 2000)) // same id → replaces
    const recent = await store.listRecentFaces({ deviceId: 7 })
    expect(recent).toHaveLength(1)
    expect(recent[0]!.timestamp).toBe(2000)
  })

  it('listRecentFaces returns only UNASSIGNED faces, newest first, honoring limit', async () => {
    await store.insert(faceRecord('a', 7, 'a', 1000))
    await store.insert(faceRecord('b', 7, 'b', 3000))
    await store.insert(faceRecord('c', 7, 'c', 2000, true)) // assigned → excluded
    const recent = await store.listRecentFaces({ deviceId: 7, limit: 10 })
    expect(recent.map((f) => f.id)).toEqual(['b', 'a'])
  })

  it('listAllRecentFaces can restrict recognized rows to one camera', async () => {
    await store.insert({
      ...faceRecord('camera-7', 7, 'camera-7', 1_000),
      recognizedIdentityId: 'alice',
    })
    await store.insert({
      ...faceRecord('camera-8', 8, 'camera-8', 2_000),
      recognizedIdentityId: 'bob',
    })

    const recent = await store.listAllRecentFaces({
      deviceIds: [7],
      filter: 'recognized',
      limit: 1,
    })
    expect(recent.map((row) => row.id)).toEqual(['camera-7'])
  })

  it('identified includes manually assigned faces while recognized keeps them out', async () => {
    await store.insert({
      ...faceRecord('assigned', 7, 'assigned', 1_000, true),
      recognizedIdentityId: 'alice',
    })
    expect(await store.listAllRecentFaces({ deviceIds: [7], filter: 'recognized' })).toEqual([])
    expect(
      (await store.listAllRecentFaces({ deviceIds: [7], filter: 'identified' })).map(
        (row) => row.id,
      ),
    ).toEqual(['assigned'])
  })

  it('markAssigned flips assigned + sets recognizedIdentityId', async () => {
    await store.insert(faceRecord('a', 7, 'a', 1000))
    await store.markAssigned('a', 'identity-1')
    const recent = await store.listRecentFaces({ deviceId: 7 })
    expect(recent).toHaveLength(0) // now assigned → excluded from the buffer
  })

  // Regression: the relational backend surfaces unset optional columns as SQL
  // NULL. A raw spread leaked `recognizedIdentityId: null`, which the FaceInfo
  // output schema (`z.string().optional()`) rejects → `faceGallery.listRecentFaces`
  // failed output validation and the People page rendered empty.
  it('normalizes SQL NULL optional columns to undefined (listAllRecentFaces + listRecentFaces)', async () => {
    await seedLedgerRows(ledgers.faces, [
      {
        id: 'n1',
        data: {
          deviceId: 7,
          trackId: 'n1',
          timestamp: 1000,
          embedding: [0.1],
          mediaId: null,
          recognizedIdentityId: null,
          assigned: 0,
          assignedSampleId: null,
        },
      },
    ])
    for (const f of [
      (await store.listAllRecentFaces({}))[0],
      (await store.listRecentFaces({ deviceId: 7 }))[0],
    ]) {
      expect(f).toBeDefined()
      expect(f!.recognizedIdentityId).toBeUndefined()
      expect(f!.assignedSampleId).toBeUndefined()
      expect(f!.mediaId).toBeUndefined()
      expect(f!.assigned).toBe(false) // 0 → false
      // No own-property may hold null (the optional-string schema rejects null).
      for (const v of Object.values(f!)) expect(v).not.toBeNull()
    }
  })

  it('round-trips bestMatchScore + nativeFaceShortSidePx (auditability fields)', async () => {
    await store.insert({
      ...faceRecord('a', 7, 'a', 1000),
      bestMatchScore: 0.83,
      nativeFaceShortSidePx: 96,
    })
    const [row] = await store.listRecentFaces({ deviceId: 7 })
    expect(row!.bestMatchScore).toBeCloseTo(0.83)
    expect(row!.nativeFaceShortSidePx).toBe(96)
    const got = await store.get('a')
    expect(got!.bestMatchScore).toBeCloseTo(0.83)
    expect(got!.nativeFaceShortSidePx).toBe(96)
  })

  it('legacy rows without the auditability columns read back as undefined (null-normalized)', async () => {
    await seedLedgerRows(ledgers.faces, [
      {
        id: 'legacy',
        data: {
          deviceId: 7,
          trackId: 'legacy',
          timestamp: 1000,
          embedding: [0.1],
          assigned: 0,
          // No bestMatchScore / nativeFaceShortSidePx columns (or SQL NULL).
          bestMatchScore: null,
          nativeFaceShortSidePx: null,
        },
      },
    ])
    const got = await store.get('legacy')
    expect(got!.bestMatchScore).toBeUndefined()
    expect(got!.nativeFaceShortSidePx).toBeUndefined()
    const [listed] = await store.listAllRecentFaces({})
    expect(listed!.bestMatchScore).toBeUndefined()
    expect(listed!.nativeFaceShortSidePx).toBeUndefined()
  })

  it('round-trips suggestedIdentityId + suggestedMatchScore (suggested-assignment tier)', async () => {
    await store.insert({
      ...faceRecord('a', 7, 'a', 1000),
      suggestedIdentityId: 'id-bob',
      suggestedMatchScore: 0.57,
    })
    const [row] = await store.listRecentFaces({ deviceId: 7 })
    expect(row!.suggestedIdentityId).toBe('id-bob')
    expect(row!.suggestedMatchScore).toBeCloseTo(0.57)
    const got = await store.get('a')
    expect(got!.suggestedIdentityId).toBe('id-bob')
    expect(got!.suggestedMatchScore).toBeCloseTo(0.57)
  })

  it('legacy rows without the suggestion columns read back as undefined (null-normalized)', async () => {
    await seedLedgerRows(ledgers.faces, [
      {
        id: 'legacy2',
        data: {
          deviceId: 7,
          trackId: 'legacy2',
          timestamp: 1000,
          embedding: [0.1],
          assigned: 0,
          suggestedIdentityId: null,
          suggestedMatchScore: null,
        },
      },
    ])
    const got = await store.get('legacy2')
    expect(got!.suggestedIdentityId).toBeUndefined()
    expect(got!.suggestedMatchScore).toBeUndefined()
    const [listed] = await store.listAllRecentFaces({})
    expect(listed!.suggestedIdentityId).toBeUndefined()
    expect(listed!.suggestedMatchScore).toBeUndefined()
    // No own-property may hold null (the FaceInfo optional-string schema rejects null).
    for (const v of Object.values(listed!)) expect(v).not.toBeNull()
  })
})

describe('FaceStore — pruneCapOverflow', () => {
  let store: FaceStore

  beforeEach(async () => {
    ;({ store } = await makeFaceWorld())
  })

  it('enforces the per-device cap, keeping the newest', async () => {
    for (let i = 0; i < 5; i++) await store.insert(faceRecord(`f${i}`, 7, `f${i}`, 1000 + i))
    const deleted = await store.pruneCapOverflow({ maxPerDevice: 2, maxSuggestedPerDevice: 8 })
    // keeps f4, f3 (newest 2); deletes f0,f1,f2
    expect(new Set(deleted)).toEqual(new Set(['f0', 'f1', 'f2']))
    expect((await store.listRecentFaces({ deviceId: 7 })).map((f) => f.id)).toEqual(['f4', 'f3'])
  })

  it('NEVER deletes by age — a face inside the cap survives any age (D61)', async () => {
    // The face buffer used to prune on `bufferRetentionDays` OR the cap. The age
    // half was a clock over a TRACK-OWNED entity and aged crops out from under
    // tracks still well inside their own window. Only the capacity bound remains.
    await store.insert(faceRecord('ancient', 7, 'ancient', 1))
    const deleted = await store.pruneCapOverflow({ maxPerDevice: 50, maxSuggestedPerDevice: 200 })
    expect(deleted).toEqual([])
    expect((await store.listRecentFaces({ deviceId: 7 })).map((f) => f.id)).toEqual(['ancient'])
  })

  it('caps each device independently', async () => {
    for (let i = 0; i < 3; i++) await store.insert(faceRecord(`a${i}`, 7, `a${i}`, 1000 + i))
    await store.insert(faceRecord('b', 99, 'b', 1000))
    const deleted = await store.pruneCapOverflow({ maxPerDevice: 2, maxSuggestedPerDevice: 8 })
    expect(new Set(deleted)).toEqual(new Set(['a0']))
    expect((await store.listRecentFaces({ deviceId: 99 })).map((f) => f.id)).toEqual(['b'])
  })
})

describe('FaceStore — pruneCapOverflow, the suggested tier', () => {
  let log: LogCapture
  let store: FaceStore

  beforeEach(async () => {
    log = makeLogCapture()
    ;({ store } = await makeFaceWorld(log.logger))
  })

  /**
   * The defect this pins: on 15 of 24 live cameras the buffer sat at exactly
   * the cap, so on a busy camera a suggestion the operator had not answered was
   * deleted within about a day. A row the system asked a question about must
   * outlive a row it said nothing about.
   */
  it('keeps a suggested row and evicts an unsuggested row of the SAME age', async () => {
    await store.insert(suggested('asked', 7, 1_000))
    await store.insert(faceRecord('silent', 7, 'silent', 1_000))

    const deleted = await store.pruneCapOverflow({ maxPerDevice: 0, maxSuggestedPerDevice: 8 })

    expect(deleted).toEqual(['silent'])
    expect(await store.get('asked')).not.toBeNull()
    expect(await store.get('silent')).toBeNull()
  })

  it('a suggested row does not consume an unsuggested cap slot', async () => {
    // One slot. The suggested row must not be the thing that fills it.
    await store.insert(suggested('asked', 7, 3_000))
    await store.insert(faceRecord('keep', 7, 'keep', 2_000))
    await store.insert(faceRecord('drop', 7, 'drop', 1_000))

    const deleted = await store.pruneCapOverflow({ maxPerDevice: 1, maxSuggestedPerDevice: 8 })

    expect(deleted).toEqual(['drop'])
    expect((await store.get('keep'))?.id).toBe('keep')
    expect((await store.get('asked'))?.id).toBe('asked')
  })

  it('BOUNDS the suggested tier — an exemption without a bound is a leak', async () => {
    for (let i = 0; i < 5; i++) await store.insert(suggested(`s${i}`, 7, 1_000 + i))

    const deleted = await store.pruneCapOverflow({ maxPerDevice: 50, maxSuggestedPerDevice: 2 })

    // Oldest-first within the tier: s0, s1 go; the two newest survive.
    expect(new Set(deleted)).toEqual(new Set(['s0', 's1', 's2']))
    const left = await store.listRecentFaces({ deviceId: 7 })
    expect(left.map((f) => f.id)).toEqual(['s4', 's3'])
  })

  it('bounds the suggested tier PER DEVICE, not globally', async () => {
    for (let i = 0; i < 3; i++) await store.insert(suggested(`a${i}`, 7, 1_000 + i))
    for (let i = 0; i < 3; i++) await store.insert(suggested(`b${i}`, 99, 1_000 + i))

    const deleted = await store.pruneCapOverflow({ maxPerDevice: 50, maxSuggestedPerDevice: 2 })

    expect(new Set(deleted)).toEqual(new Set(['a0', 'b0']))
  })

  /**
   * Silence reads as "never happened" — which is exactly how a day-long
   * suggestion lifetime went unnoticed on 24 cameras. Every drop of an
   * unanswered question names its camera.
   */
  it('logs an evicted suggested row with tags.deviceId — the NUMERIC id', async () => {
    for (let i = 0; i < 3; i++) await store.insert(suggested(`s${i}`, 108, 1_000 + i))

    await store.pruneCapOverflow({ maxPerDevice: 50, maxSuggestedPerDevice: 1 })

    const lines = log.warns.filter((w) => w.message.includes('UNANSWERED suggestions'))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.extras?.tags).toEqual({ deviceId: 108 })
    expect(lines[0]!.extras?.meta).toMatchObject({ deleted: 2, cap: 1 })
  })

  it('does NOT log a suggested eviction when only unsuggested rows were dropped', async () => {
    await store.insert(faceRecord('plain', 7, 'plain', 1_000))

    await store.pruneCapOverflow({ maxPerDevice: 0, maxSuggestedPerDevice: 8 })

    expect(log.warns.filter((w) => w.message.includes('UNANSWERED suggestions'))).toEqual([])
  })

  it('an ENROLLED row that also carries a suggestion is still fully exempt', async () => {
    await store.insert({ ...suggested('enrolled', 7, 1_000), assigned: true })

    const deleted = await store.pruneCapOverflow({ maxPerDevice: 0, maxSuggestedPerDevice: 0 })

    expect(deleted).toEqual([])
  })

  /** A cleared suggestion (`setSuggestion(id, null)`) returns the row to the
   *  ordinary tier — the question was withdrawn, so it earns no protection. */
  it('a CLEARED suggestion returns the row to the unsuggested tier', async () => {
    await store.insert(suggested('withdrawn', 7, 1_000))
    await store.setSuggestion('withdrawn', null)

    const deleted = await store.pruneCapOverflow({ maxPerDevice: 0, maxSuggestedPerDevice: 8 })

    expect(deleted).toEqual(['withdrawn'])
  })
})

describe('FaceStore — enrolment exemption', () => {
  let store: FaceStore

  beforeEach(async () => {
    ;({ store } = await makeFaceWorld())
  })

  it('pruneCapOverflow does NOT delete assigned faces, and they consume no cap slot', async () => {
    await store.insert(faceRecord('face-A', 1, 'A', 1, true)) // assigned
    await store.insert(faceRecord('face-B', 1, 'B', 2)) // unassigned
    const deleted = await store.pruneCapOverflow({ maxPerDevice: 0, maxSuggestedPerDevice: 0 })
    expect(deleted).not.toContain('face-A')
    expect(deleted).toContain('face-B')
  })
})

describe('FaceStore — clearAssignment', () => {
  let store: FaceStore

  beforeEach(async () => {
    ;({ store } = await makeFaceWorld())
  })

  it('clears assigned, recognizedIdentityId, and assignedSampleId', async () => {
    await store.insert(faceRecord('face-A', 1, 'A', 1000))
    await store.markAssigned('face-A', 'identity-1', 'sample-1')
    await store.clearAssignment('face-A')
    const result = await store.get('face-A')
    expect(result).not.toBeNull()
    expect(result!.assigned).toBe(false)
    expect(result!.recognizedIdentityId).toBeUndefined()
    expect(result!.assignedSampleId).toBeUndefined()
  })
})

describe('FaceStore — setSuggestion (face.rescoreTrack persistence)', () => {
  let store: FaceStore

  beforeEach(async () => {
    ;({ store } = await makeFaceWorld())
  })

  it('writes a fresh identityId + score, never touching assigned/recognizedIdentityId', async () => {
    await store.insert(faceRecord('face-A', 1, 'A', 1000))
    await store.setSuggestion('face-A', { identityId: 'alice', score: 0.71 })
    const result = await store.get('face-A')
    expect(result!.suggestedIdentityId).toBe('alice')
    expect(result!.suggestedMatchScore).toBeCloseTo(0.71)
    expect(result!.assigned).toBe(false)
    expect(result!.recognizedIdentityId).toBeUndefined()
  })

  it('a null suggestion CLEARS both columns — a real result, not a no-op', async () => {
    await store.insert({
      ...faceRecord('face-A', 1, 'A', 1000),
      suggestedIdentityId: 'stale-id',
      suggestedMatchScore: 0.9,
    })
    await store.setSuggestion('face-A', null)
    const result = await store.get('face-A')
    expect(result!.suggestedIdentityId).toBeUndefined()
    expect(result!.suggestedMatchScore).toBeUndefined()
  })

  it('overwrites a previous suggestion (recompute supersedes the prior recompute)', async () => {
    await store.insert({
      ...faceRecord('face-A', 1, 'A', 1000),
      suggestedIdentityId: 'bob',
      suggestedMatchScore: 0.5,
    })
    await store.setSuggestion('face-A', { identityId: 'alice', score: 0.88 })
    const result = await store.get('face-A')
    expect(result!.suggestedIdentityId).toBe('alice')
    expect(result!.suggestedMatchScore).toBeCloseTo(0.88)
  })
})

describe('FaceStore — markAssigned with sampleId', () => {
  let store: FaceStore

  beforeEach(async () => {
    ;({ store } = await makeFaceWorld())
  })

  it('markAssigned with sampleId persists assignedSampleId', async () => {
    await store.insert(faceRecord('face-A', 1, 'A', 1000))
    await store.markAssigned('face-A', 'identity-1', 'sample-xyz')
    const result = await store.get('face-A')
    expect(result).not.toBeNull()
    expect(result!.assigned).toBe(true)
    expect(result!.recognizedIdentityId).toBe('identity-1')
    expect(result!.assignedSampleId).toBe('sample-xyz')
  })

  it('markAssigned without sampleId remains backward-compatible', async () => {
    await store.insert(faceRecord('face-A', 1, 'A', 1000))
    await store.markAssigned('face-A', 'identity-1')
    const result = await store.get('face-A')
    expect(result).not.toBeNull()
    expect(result!.assigned).toBe(true)
    expect(result!.recognizedIdentityId).toBe('identity-1')
    expect(result!.assignedSampleId).toBeUndefined()
  })
})

/**
 * The two whole-collection sweeps, at a size that crosses a page boundary.
 *
 * Every other test in this file seeds a handful of rows, which fits in one
 * page — so a broken (or absent) paging loop passes all of them. That is the
 * exact shape of "green because the fake never asked the question": the
 * unbounded read these tests were written against is the one that killed
 * hub-main on 2026-08-07.
 */
describe('FaceStore — whole-collection sweeps stay bounded AND complete', () => {
  let world: FakeRecords
  let ledgers: AnalyticsLedgers
  let store: FaceStore
  /** Every page the faces kind was asked for, in order. */
  const issued = (): readonly { readonly limit: number }[] =>
    world.queries.filter((q) => q.kind === 'faces')

  beforeEach(async () => {
    ;({ world, ledgers, store } = await makeFaceWorld())
  })

  /** Seed `n` unassigned faces on one device, newest id first. */
  async function seedFaces(
    n: number,
    deviceId: number,
    opts?: { assigned?: (i: number) => boolean },
  ): Promise<void> {
    await seedLedgerRows(
      ledgers.faces,
      Array.from({ length: n }, (_, i) => ({
        id: `f${String(i).padStart(6, '0')}`,
        data: {
          deviceId,
          trackId: `t${i}`,
          timestamp: 1_000_000 - i,
          embedding: [0.1, 0.2],
          assigned: opts?.assigned?.(i) ?? false,
        },
      })),
    )
  }

  it('NEVER issues an unbounded query', async () => {
    await seedFaces(FACE_SWEEP_PAGE + 250, 101)
    const before = issued().length
    await store.pruneCapOverflow({ maxPerDevice: 10, maxSuggestedPerDevice: 40 })
    await store.listAllRecentFaces({ filter: 'unassigned' })
    const sent = issued().slice(before)
    expect(sent.length).toBeGreaterThan(0)
    expect(
      // Bounded: the sweep's page, or the list's window ceiling + 1 sentinel row.
      sent.filter((f) => f.limit > Math.max(FACE_SWEEP_PAGE, FACE_WINDOW_MAX_ROWS + 1)),
      'an unbounded query is what materialised the table into V8',
    ).toEqual([])
  })

  it('pruneCapOverflow considers rows BEYOND the first page', async () => {
    const total = FACE_SWEEP_PAGE + 250
    await seedFaces(total, 101)
    const before = issued().length
    const deleted = await store.pruneCapOverflow({ maxPerDevice: 10, maxSuggestedPerDevice: 40 })
    // A single-page read would have seen only FACE_SWEEP_PAGE rows and deleted
    // FACE_SWEEP_PAGE - 10 of them, leaving 250 overflow rows alive forever.
    expect(deleted).toHaveLength(total - 10)
    expect(issued().length - before).toBeGreaterThan(1)
  })

  it('listAllRecentFaces finds a match that lives past the first page', async () => {
    // The whole first page is assigned; the only unassigned row is last.
    const total = FACE_SWEEP_PAGE + 5
    await seedFaces(total, 101, { assigned: (i) => i < total - 1 })
    const found = await store.listAllRecentFaces({ filter: 'unassigned' })
    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe(`f${String(total - 1).padStart(6, '0')}`)
  })

  it('listAllRecentFaces stops paging as soon as the limit is satisfied', async () => {
    await seedFaces(FACE_SWEEP_PAGE * 3, 101)
    const before = issued().length
    const found = await store.listAllRecentFaces({
      filter: 'unassigned',
      limit: 5,
    })
    expect(found).toHaveLength(5)
    // One page was enough — the other two must never have been fetched.
    expect(issued().length - before).toBe(1)
  })

  it('applies the limit AFTER the filter, not before it (unchanged semantics)', async () => {
    // Newest 3 are assigned; a limit of 2 must still return 2 UNASSIGNED faces.
    await seedFaces(10, 101, { assigned: (i) => i < 3 })
    const found = await store.listAllRecentFaces({
      filter: 'unassigned',
      limit: 2,
    })
    expect(found).toHaveLength(2)
    expect(found.every((f) => !f.assigned)).toBe(true)
  })
})
