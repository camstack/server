/**
 * The event-media SEAL is a bulk metadata stamp, and it must cost like one.
 *
 * `relocateMedia({ mode: 'seal' })` writes ONE field on rows that already sit
 * where they claim: no file is read, no byte moves, no disk is touched. It
 * existed as a per-row loop — page the whole collection, then
 * `store.set.mutate` one full-row UPSERT per selected row, rewriting every
 * column to change `locationId`.
 *
 * Measured on the live hub (2026-08-30, contended: the `recordingsLow` drain
 * was competing for the same disk): **1 170 rows in 8 min 29 s ≈ 2.3 rows/s**,
 * falling to 0.7 rows/s once the drain resumed. The 464 902 unstamped rows it
 * exists to stamp would have taken over two and a half days, and the job was
 * cancelled. Same table, same door, same shape as `getEventStoreFootprint`:
 * work looped over the door instead of pushed into the statement.
 *
 * ## What is load-bearing
 *
 * The assertions are on the STATEMENT COUNT for N rows — `calls.set` and
 * `calls.updateWhere` — never wall clock. A test that only checked the rows
 * came out stamped is green on both implementations; that is exactly the class
 * of test this repo has shipped six of.
 *
 * ## The three properties a seal cannot lose
 *
 *  1. **Idempotent.** Re-running stamps nothing and reports nothing stamped.
 *  2. **Non-destructive.** A row already naming a DIFFERENT location keeps it.
 *     `WHERE locationId IS NULL` has this for free; the test proves the
 *     predicate really is that one.
 *  3. **Resumable.** It is interrupted by design — one was cancelled in flight
 *     today — so a second run must stamp only the remainder.
 *
 * And the failure D312 exists about: `where: { locationId: null }` used to
 * compile to `= NULL`, which matches nothing and says so without erroring. A
 * probe-then-stamp loop against that backend never terminates. The guard for
 * it is asserted here, because "it cannot happen now" is what the previous
 * three places said.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { MediaBlobStorage } from '../location-aware-media-storage.js'
import { MediaRelocateEngine } from '../media-relocate-engine.js'
import type { EventLedgerCollection } from '../store/event-ledger-collection.js'
import { wireRetrainFrameLedger } from '../store/event-ledger-wiring.js'
import { MEDIA_COLLECTION, MediaStore } from '../store/media-store.js'
import { type FakeRecords, kindRow, makeAnalyticsRecords, seedLedgerRows } from './fake-records.js'
import { type FakeSettingsStore, makeFakeSettingsStore, makeSilentLogger } from './test-helpers.js'

const TARGET = 'eventMedia:default'
const OTHER = 'eventMedia:archive'

/**
 * Unstamped rows in the fixture. Larger than any plausible batch size, so a
 * per-row implementation and a batched one are separated by two orders of
 * magnitude rather than by one call.
 */
const UNSTAMPED = 1_200

/** Rows that already name a location the seal must not touch. */
const FOREIGN = 40

const storage: MediaBlobStorage = {
  write: async () => undefined,
  read: async () => Buffer.alloc(0),
  delete: async () => undefined,
}

interface Harness {
  readonly engine: MediaRelocateEngine
  readonly fake: FakeSettingsStore
  /** Retrain frames are a records kind: the world, and the ledger the engine reads. */
  readonly world: FakeRecords
  readonly frameLedger: EventLedgerCollection
}

function mediaRow(index: number, locationId: string | null): Record<string, unknown> {
  return {
    deviceId: 101,
    ownerKind: 'object',
    ownerId: `e-${index}`,
    kind: 'snapshot',
    timestamp: 1_700_000_000_000 + index,
    path: `101/events/object/e-${index}/snapshot-${index}.jpg`,
    sizeBytes: 4_096,
    locationId,
    provenance: null,
  }
}

async function makeHarness(options?: { readonly preStamped?: number }): Promise<Harness> {
  const fake = makeFakeSettingsStore()
  await MediaStore.declare(fake.client)
  const world = await makeAnalyticsRecords()
  const frameLedger = wireRetrainFrameLedger({ records: world.records })

  const preStamped = options?.preStamped ?? 0
  fake.seed(MEDIA_COLLECTION, [
    // Rows already sealed by an earlier, interrupted run.
    ...Array.from({ length: preStamped }, (_, i) => ({
      id: `m-done-${i}`,
      data: mediaRow(i, TARGET),
    })),
    ...Array.from({ length: UNSTAMPED }, (_, i) => ({
      id: `m-${i}`,
      data: mediaRow(1_000_000 + i, null),
    })),
    // Rows that live somewhere else on purpose. A seal that repoints these is
    // the failure D197 exists about: a blob deliberately moved off the footage
    // volume being re-aimed at it.
    ...Array.from({ length: FOREIGN }, (_, i) => ({
      id: `m-foreign-${i}`,
      data: mediaRow(2_000_000 + i, OTHER),
    })),
  ])

  const logger: IScopedLogger = makeSilentLogger()
  const engine = new MediaRelocateEngine({
    store: fake.client,
    retrainFrameLedger: frameLedger,
    storage,
    logger,
    now: () => 1,
    newId: () => `seal-${Math.random()}`,
    resolveTargetRoot: async () => '/target',
    sleep: async () => {},
  })
  fake.calls.set = 0
  fake.calls.updateWhere = 0
  fake.calls.query = 0
  fake.calls.rowsRead = 0
  return { engine, fake, world, frameLedger }
}

async function runSeal(h: Harness): Promise<{ state: string; filesMoved: number }> {
  const jobId = h.engine.start({ mode: 'seal', toLocationId: TARGET })
  for (let i = 0; i < 2_000; i++) {
    const job = h.engine.list().find((candidate) => candidate.jobId === jobId)
    if (job && job.state !== 'running') {
      return { state: job.state, filesMoved: job.filesMoved }
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('seal did not finish')
}

/** `locationId` of every media row, by id. */
function locations(h: Harness): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const [id, row] of h.fake.data.get(MEDIA_COLLECTION) ?? []) {
    out.set(id, row['locationId'] ?? null)
  }
  return out
}

describe('the event-media seal is a bulk statement, not a row loop', () => {
  /**
   * THE load-bearing assertion. 1 200 rows must not cost 1 200 writes.
   *
   * The bound is deliberately loose — this pins the ORDER, not a batch size —
   * but it is two orders of magnitude below the retired shape, which is the
   * difference between minutes and days on the real population.
   */
  it('stamps 1 200 rows without a single per-row write', async () => {
    const h = await makeHarness()

    const job = await runSeal(h)

    expect(job.state).toBe('done')
    expect(h.fake.calls.set).toBe(0)
    expect(h.fake.calls.updateWhere).toBeLessThanOrEqual(UNSTAMPED / 100)
  })

  /**
   * The pass must also stop READING the whole collection to find its work.
   * The unstamped population is an indexed range (`idx_media_location`); the
   * already-stamped rows behind it have no business crossing the door.
   */
  it('reads only the rows it is going to stamp', async () => {
    const h = await makeHarness({ preStamped: 800 })

    await runSeal(h)

    // 1 200 unstamped rows probed once each, plus one probe that finds the
    // range empty. Never the 2 040-row collection, and never it repeatedly.
    expect(h.fake.calls.rowsRead).toBeLessThanOrEqual(UNSTAMPED)
  })

  it('stamps every unstamped row and reports the count it stamped', async () => {
    const h = await makeHarness()

    const job = await runSeal(h)

    expect(job.filesMoved).toBe(UNSTAMPED)
    const after = locations(h)
    for (let i = 0; i < UNSTAMPED; i++) expect(after.get(`m-${i}`)).toBe(TARGET)
  })

  it('never repoints a row that already names a different location', async () => {
    const h = await makeHarness()

    await runSeal(h)

    const after = locations(h)
    for (let i = 0; i < FOREIGN; i++) expect(after.get(`m-foreign-${i}`)).toBe(OTHER)
  })

  it('is idempotent — a second run stamps nothing', async () => {
    const h = await makeHarness()
    await runSeal(h)
    const afterFirst = locations(h)

    h.fake.calls.updateWhere = 0
    const second = await runSeal(h)

    expect(second.state).toBe('done')
    expect(second.filesMoved).toBe(0)
    expect(h.fake.calls.updateWhere).toBe(0)
    expect(locations(h)).toEqual(afterFirst)
  })

  /**
   * Resume. A run that was interrupted leaves stamped rows stamped; the next
   * one must see only the remainder — which the `IS NULL` predicate gives for
   * free, and which nothing else in this file would notice losing.
   */
  it('resumes on the remainder after an interrupted run', async () => {
    const h = await makeHarness({ preStamped: 800 })

    const job = await runSeal(h)

    expect(job.filesMoved).toBe(UNSTAMPED)
    const after = locations(h)
    for (let i = 0; i < 800; i++) expect(after.get(`m-done-${i}`)).toBe(TARGET)
    expect([...after.values()].filter((l) => l === null)).toHaveLength(0)
  })

  /**
   * The D312 failure, reproduced: a backend whose bulk predicate matches
   * nothing and says so without erroring.
   *
   * The job must FAIL. It must not spin forever re-probing rows it can never
   * stamp, and it must not report a completed seal having stamped nothing —
   * which is the answer the migration gate treats as "safe to cut over".
   */
  it('fails loudly when the bulk predicate matches nothing', async () => {
    const h = await makeHarness()
    h.fake.faults.updateWhereMatchesNothing = true

    const job = await runSeal(h)

    expect(job.state).toBe('failed')
    expect(job.filesMoved).toBe(0)
  })

  it('reports the unstamped population as the denominator', async () => {
    const h = await makeHarness({ preStamped: 800 })
    const jobId = h.engine.start({ mode: 'seal', toLocationId: TARGET })
    for (let i = 0; i < 2_000; i++) {
      const job = h.engine.list().find((c) => c.jobId === jobId)
      if (job && job.state !== 'running') {
        expect(job.filesTotal).toBe(UNSTAMPED)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error('seal did not finish')
  })

  it('seals the retrain-frames collection too', async () => {
    const h = await makeHarness()
    await seedLedgerRows(h.frameLedger, [
      {
        id: 'retrain:track-a:copy',
        data: {
          deviceId: 101,
          trackId: 'track-a',
          sourceMediaKey: 'track:track-a:keyFrame',
          sourceKind: 'keyFrame',
          path: 'retrain/101/track-a/copy.jpg',
          sizeBytes: 3,
          width: 1,
          height: 1,
          copiedAt: 1,
          locationId: null,
        },
      },
    ])

    await runSeal(h)

    expect(kindRow(h.world, 'retrain-frames', 'retrain:track-a:copy')?.['locationId']).toBe(TARGET)
  })
})
