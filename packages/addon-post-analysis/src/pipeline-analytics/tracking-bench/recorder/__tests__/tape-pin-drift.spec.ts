/**
 * Reconcile re-applies every promotion's pins on each operator action and at
 * hub start (fix round 2, N1) — so it must cost nothing when nothing drifted
 * (fix round 3, D447). `hub/sqlite-settings` is one synchronous thread: up to
 * 3 000 per-row updates there would queue every configuration read in the
 * cluster behind a reconcile that changed nothing.
 *
 * Pinned here, through the REAL `TrackStore` (on a fake settings store, whose
 * writes are counted) and the REAL index store (on its records kind):
 *  - a reconcile with no drift writes zero rows and makes no per-row update;
 *  - a drifted pin (a late unpin, probe P5) is repaired — and only it is
 *    written.
 *
 * Disarm: drop the drift predicate from `TrackStore.setBenchPinned`'s
 * set-based statement (`whereNot: { benchPinned: true }` for a pin) — "a
 * reconcile with no drift writes nothing" fails (2 rows rewritten).
 */
import type { SettingsStoreClient } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeAnalyticsWorld } from '../../../__tests__/fake-records.js'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeLogRecorder,
} from '../../../__tests__/test-helpers.js'
import { TRACKS_COLLECTION, TrackStore } from '../../../store/track-store.js'
import {
  TrackingTapeIndexStore,
  type TrackingTapeRow,
} from '../../../store/tracking-tape-index-store.js'
import { reconcileTapePins, type TapePinDeps } from '../tape-pin-ledger.js'

const DEVICE_ID = 101

/** Rows the settings store rewrote, and the per-row updates it was sent. */
interface WriteCount {
  rowsWritten: number
  rowUpdates: number
}

/** The fake client, with every write counted. */
function counted(fake: FakeSettingsStore, writes: WriteCount): SettingsStoreClient {
  return {
    ...fake.client,
    update: {
      mutate: async (input) => {
        writes.rowUpdates += 1
        writes.rowsWritten += 1
        return fake.client.update.mutate(input)
      },
    },
    updateWhere: {
      mutate: async (input) => {
        const result = await fake.client.updateWhere.mutate(input)
        writes.rowsWritten += result.updated
        return result
      },
    },
  }
}

function promotion(trackIds: readonly string[]): TrackingTapeRow {
  return {
    id: 'promo-0001',
    deviceId: DEVICE_ID,
    scenario: 'drift',
    note: null,
    lighting: 'day',
    fromMs: 0,
    toMs: 1_000,
    state: 'complete',
    frames: 2,
    skips: 0,
    gaps: 0,
    bytes: 10,
    reviewed: false,
    trackIds: [...trackIds],
    createdAt: 1,
    releasedAt: null,
    pinsSettled: true,
  }
}

function seedTrack(fake: FakeSettingsStore, id: string, benchPinned: boolean): void {
  fake.seed(TRACKS_COLLECTION, [
    {
      id,
      data: {
        deviceId: DEVICE_ID,
        className: 'person',
        firstSeen: 0,
        lastSeen: 100,
        retrainStatus: 'none',
        benchPinned,
      },
    },
  ])
}

describe('reconcile writes only drifted pins (fix round 3, D447)', () => {
  let fake: FakeSettingsStore
  let writes: WriteCount
  let deps: TapePinDeps
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    await TrackStore.declare(fake.client)
    const { logger } = makeLogRecorder()
    writes = { rowsWritten: 0, rowUpdates: 0 }
    const client = counted(fake, writes)
    trackStore = new TrackStore({ store: client, logger })
    const { ledgers } = await makeAnalyticsWorld()
    const index = new TrackingTapeIndexStore({ tapeLedger: ledgers.trackingTapes, logger })
    await index.insert(promotion(['trk-a', 'trk-b']))
    writes.rowsWritten = 0
    writes.rowUpdates = 0
    deps = {
      index,
      pin: (deviceId, ids, pinned) => trackStore.setBenchPinned(deviceId, ids, pinned),
      logger,
      now: () => 2,
    }
  })

  it('a reconcile with no drift writes nothing', async () => {
    seedTrack(fake, 'trk-a', true)
    seedTrack(fake, 'trk-b', true)
    expect(await reconcileTapePins(deps)).toEqual({ settled: 0, unsettled: 0 })
    expect(writes).toEqual({ rowsWritten: 0, rowUpdates: 0 })
  })

  it('a drifted pin (a late unpin, P5) is repaired, and only it is written', async () => {
    seedTrack(fake, 'trk-a', true)
    seedTrack(fake, 'trk-b', false)
    expect(await reconcileTapePins(deps)).toEqual({ settled: 0, unsettled: 0 })
    expect(writes).toEqual({ rowsWritten: 1, rowUpdates: 0 })
    expect(await trackStore.listIdsBefore(DEVICE_ID, 1_000, 100)).toEqual([])
  })
})
