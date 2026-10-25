/**
 * The promoted-tape index over the records world: what the writer cannot
 * produce (it always writes `trackIds`) but a corrupt or hand-edited row can.
 *
 * Fix round 1 (review L1): a row with no `trackIds` is REPORTED as malformed,
 * with why — never silently repaired to an empty list. Disarm: map an absent
 * `trackIds` to `[]` again in `decodeTrackIds`: this test goes RED.
 */
import { describe, expect, it } from 'vitest'
import { makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { makeLogRecorder } from '../../__tests__/test-helpers.js'
import { TrackingTapeIndexStore } from '../tracking-tape-index-store.js'

describe('TrackingTapeIndexStore over the records world', () => {
  it('a row with no trackIds is reported with why, never repaired to []', async () => {
    const { world, ledgers } = await makeAnalyticsWorld()
    const log = makeLogRecorder()
    const index = new TrackingTapeIndexStore({
      tapeLedger: ledgers.trackingTapes,
      logger: log.logger,
    })
    // Stored as the ledger's writer stores a row: header `deviceId` / `at`
    // (the `createdAt` clock) and the whole body — minus `trackIds`.
    world.seed('tracking-tapes', {
      id: 'p1',
      deviceId: 102,
      at: 3,
      data: {
        deviceId: 102,
        scenario: 'parked-cars',
        note: null,
        lighting: 'day',
        fromMs: 1,
        toMs: 2,
        state: 'complete',
        frames: 1,
        skips: 0,
        gaps: 0,
        bytes: 1,
        reviewed: false,
        createdAt: 3,
        releasedAt: null,
        pinsSettled: true,
      },
    })
    expect(await index.list(102)).toEqual([])
    expect(log.entries.map((e) => [e.level, e.extras])).toEqual([
      [
        'warn',
        {
          meta: { id: 'p1', issues: ['trackIds'], trackIdsType: 'undefined' },
          tags: { deviceId: 102 },
        },
      ],
    ])
  })
})
