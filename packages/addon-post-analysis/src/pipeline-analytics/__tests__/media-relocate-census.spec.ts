/**
 * The census behind `storageMigration.residue`, bounded.
 *
 * Measured on the live hub 2026-08-31: `MediaRelocateEngine.pageRows` was
 * **88.7 % of the `hub/sqlite-settings` engine's wall clock**, top-1 in 359 of
 * 359 consecutive profiler windows over six hours. One `residue()` is two full
 * walks of a 1.26 M-row `media` plus one of `retrain-frames` — ~12 600 store
 * round trips — and the admin UI asked for one every ten seconds. The walk
 * could not stop (`stop: () => false`) and was not single-flighted, so the
 * censuses accumulated: ~480–530 in flight, ~1 800 outstanding store requests,
 * and a ~16 s standing FIFO queue in front of every store call in the cluster.
 *
 * Every assertion here is on SHAPE — round trips issued, whether a second
 * caller reaches the store, whether the answer is representable as "I could not
 * answer". None is on wall clock; the deadline is driven by an injected `now`.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { MediaBlobStorage } from '../location-aware-media-storage.js'
import {
  MEDIA_CENSUS_DEADLINE_MS,
  MEDIA_CENSUS_ROW_BUDGET,
  MediaRelocateEngine,
} from '../media-relocate-engine.js'
import { MEDIA_COLLECTION, MediaStore } from '../store/media-store.js'
import { makeFakeSettingsStore, makeLogRecorder } from './test-helpers.js'
import type { EventLedgerCollection } from '../store/event-ledger-collection.js'
import { wireRetrainFrameLedger } from '../store/event-ledger-wiring.js'
import { makeAnalyticsRecords } from './fake-records.js'

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
  withTags: () => silent,
} as unknown as IScopedLogger

/** A census reads rows and nothing else. Any blob call is the test failing. */
const noStorage: MediaBlobStorage = {
  write: async () => {
    throw new Error('a census must not write a blob')
  },
  read: async () => {
    throw new Error('a census must not read a blob')
  },
  delete: async () => {
    throw new Error('a census must not delete a blob')
  },
}

interface EngineOverrides {
  readonly logger?: IScopedLogger
  readonly now?: () => number
}

describe('MediaRelocateEngine census — bounded, single-flighted, stoppable', () => {
  /** Each fixture's retrain-frames ledger (a records kind), by its settings store. */
  const frameLedgers = new WeakMap<
    ReturnType<typeof makeFakeSettingsStore>,
    EventLedgerCollection
  >()

  /** `rows` media rows, every other one already stamped `eventMedia:hdd`. */
  async function seedRows(rows: number): Promise<ReturnType<typeof makeFakeSettingsStore>> {
    const fake = makeFakeSettingsStore()
    await MediaStore.declare(fake.client)
    const world = await makeAnalyticsRecords()
    frameLedgers.set(fake, wireRetrainFrameLedger({ records: world.records }))
    fake.seed(
      MEDIA_COLLECTION,
      Array.from({ length: rows }, (_, index) => ({
        id: `media-${index.toString()}`,
        data: {
          deviceId: 101,
          ownerKind: 'object',
          ownerId: `e${index.toString()}`,
          kind: 'snapshot',
          timestamp: 1_000 + index,
          path: `101/events/object/e${index.toString()}/snapshot.jpg`,
          sizeBytes: 1,
          locationId: index % 2 === 0 ? null : 'eventMedia:hdd',
        },
      })),
    )
    return fake
  }

  function frameLedgerOf(fake: ReturnType<typeof makeFakeSettingsStore>): EventLedgerCollection {
    const ledger = frameLedgers.get(fake)
    if (ledger === undefined) throw new Error('fixture built without seedRows')
    return ledger
  }

  function buildEngine(
    fake: ReturnType<typeof makeFakeSettingsStore>,
    overrides: EngineOverrides = {},
  ): MediaRelocateEngine {
    return new MediaRelocateEngine({
      store: fake.client,
      retrainFrameLedger: frameLedgerOf(fake),
      storage: noStorage,
      logger: overrides.logger ?? silent,
      now: overrides.now ?? (() => 1),
      newId: () => 'census-1',
      resolveTargetRoot: async () => '/target',
      sleep: async () => {},
    })
  }

  it('serves two concurrent callers from ONE walk, not two', async () => {
    const solo = await seedRows(600)
    const soloEngine = buildEngine(solo)
    const beforeSolo = solo.calls.query
    const alone = await soloEngine.countSelectable({ toLocationId: 'eventMedia:hdd' })
    const walkCost = solo.calls.query - beforeSolo
    expect(walkCost).toBeGreaterThan(1)

    const fake = await seedRows(600)
    const engine = buildEngine(fake)
    const before = fake.calls.query
    const [first, second] = await Promise.all([
      engine.countSelectable({ toLocationId: 'eventMedia:hdd' }),
      engine.countSelectable({ toLocationId: 'eventMedia:hdd' }),
    ])

    expect(fake.calls.query - before).toBe(walkCost)
    expect(first).toEqual(alone)
    expect(second).toEqual(alone)
  })

  /** …and the joiner is keyed on the QUESTION. One census shared across two
   *  targets would answer one of them with the other's number. */
  it('never answers one question with another question’s census', async () => {
    const fake = await seedRows(400)
    const engine = buildEngine(fake)
    const [toHdd, toSsd] = await Promise.all([
      engine.countSelectable({ toLocationId: 'eventMedia:hdd' }),
      engine.countSelectable({ toLocationId: 'eventMedia:ssd' }),
    ])
    // Half the rows are already on `eventMedia:hdd`, so a move there selects
    // the other half; a move to `eventMedia:ssd` selects every row.
    expect(toHdd).toEqual({ rows: 200 })
    expect(toSsd).toEqual({ rows: 400 })
  })

  it('releases the flight when it settles, so the next ask is a fresh census', async () => {
    const fake = await seedRows(400)
    const engine = buildEngine(fake)
    const first = await engine.countSelectable({ toLocationId: 'eventMedia:hdd' })
    const between = fake.calls.query
    const second = await engine.countSelectable({ toLocationId: 'eventMedia:hdd' })
    expect(second).toEqual(first)
    expect(fake.calls.query).toBeGreaterThan(between)
  })

  it('answers null — never a number — when the collection outruns its row budget', async () => {
    const fake = await seedRows(MEDIA_CENSUS_ROW_BUDGET + 400)
    const log = makeLogRecorder()
    const engine = buildEngine(fake, { logger: log.logger })
    const before = fake.calls.query

    const answer = await engine.countSelectable({ toLocationId: 'eventMedia:hdd' })

    expect(answer).toBeNull()
    // The budget is a STOP SIGNAL, not a filter: the round trips end with it.
    expect(fake.calls.query - before).toBeLessThanOrEqual(MEDIA_CENSUS_ROW_BUDGET / 200 + 2)
    // A branch that drops work says so.
    expect(log.entries.some((e) => e.level === 'warn' && /census/i.test(e.message))).toBe(true)
  })

  it('answers null when the walk outlives its deadline, whatever the row count', async () => {
    const fake = await seedRows(4_000)
    let clock = 0
    const engine = buildEngine(fake, {
      // One second per reading: the deadline lands long before the row budget
      // on a collection this size, and lands deterministically.
      now: () => {
        clock += MEDIA_CENSUS_DEADLINE_MS / 4
        return clock
      },
    })
    const before = fake.calls.query

    const answer = await engine.countSelectable({ toLocationId: 'eventMedia:hdd' })

    expect(answer).toBeNull()
    expect(fake.calls.query - before).toBeLessThan(20)
  })

  it('stops a census on demand, and the retired census answers null', async () => {
    const fake = await seedRows(4_000)
    const engine = buildEngine(fake)
    const before = fake.calls.query

    const inFlight = engine.countSelectable({ toLocationId: 'eventMedia:hdd' })
    const retired = engine.cancelCensuses('a test asked')

    expect(retired).toBe(1)
    expect(await inFlight).toBeNull()
    expect(fake.calls.query - before).toBeLessThan(5)
  })

  it('retires standing censuses when a pass starts — the pass changes the number they count', async () => {
    const fake = await seedRows(4_000)
    const engine = buildEngine(fake)
    const inFlight = engine.countSelectable({ toLocationId: 'eventMedia:hdd' })
    engine.start({ toLocationId: 'eventMedia:hdd' })
    expect(await inFlight).toBeNull()
  })
})
