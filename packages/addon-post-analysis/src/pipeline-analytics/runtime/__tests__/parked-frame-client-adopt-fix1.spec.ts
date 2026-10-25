/**
 * D683 Task 17 fix round 1 — a fused survivor reads the CURRENT best shot.
 *
 * Disarms (each alone, restored):
 *  - `awaitPark` awaits only the survivor's own key (review H1):
 *    "awaitPark on the survivor waits for the absorbed piece's park" fails;
 *  - drop the supersede step in `remember` (review H3):
 *    "a newer survivor park wins over the adopted parcel" fails;
 *  - drop the in-flight re-release in `release`:
 *    "a park still in flight at release is released when it lands" fails;
 *  - drop the eviction log (review L5): "evicting a fused survivor's members is logged" fails.
 */
import type { ParkTrackFrameResult } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeLogRecorder } from '../../__tests__/test-helpers.js'
import { createParkedFrameClient } from '../parked-frame-client.js'
import {
  buildParkedClientForTest,
  makeApi,
  NODE_ID,
  parkOrder,
} from './parked-frame-test-helpers.js'

const PARKED: ParkTrackFrameResult = {
  parked: true,
  nodeId: NODE_ID,
  width: 3840,
  height: 2160,
  bytes: 1_800_000,
  replaced: false,
}

/** An api whose FIRST park stays open until `land()` is called. */
function heldParkApi() {
  let land: () => void = () => {}
  const held = new Promise<ParkTrackFrameResult>((resolve) => {
    land = () => resolve(PARKED)
  })
  let first = true
  const park = vi.fn(async () => {
    if (first) {
      first = false
      return held
    }
    return PARKED
  })
  return { api: makeApi({ park }), land: () => land() }
}

describe('ParkedFrameClient.adopt — fix round 1', () => {
  it('awaitPark on the survivor waits for the absorbed piece’s park (H1)', async () => {
    const { api, land } = heldParkApi()
    const client = createParkedFrameClient({ api, logger: makeLogRecorder().logger })
    void client.park(parkOrder({ trackId: 'B', kind: 'keyFrame' }))
    client.adopt('A', 'B', 'absorbed')
    let settled = false
    const waiting = client.awaitPark('A', 'keyFrame').then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    land()
    await waiting
    expect(client.info('A', 'keyFrame')).toBeDefined()
    expect(client.info('A', 'keyFrame')).toEqual(client.info('B', 'keyFrame'))
  })

  it('a newer survivor park wins over the adopted parcel (H3)', async () => {
    const { client } = buildParkedClientForTest()
    await client.park({ ...parkOrder({ trackId: 'B', kind: 'keyFrame' }), timestamp: 5_000 })
    client.adopt('A', 'B', 'absorbed')
    expect(client.info('A', 'keyFrame')?.timestamp).toBe(5_000)
    await client.park({ ...parkOrder({ trackId: 'A', kind: 'keyFrame' }), timestamp: 9_000 })
    expect(client.info('A', 'keyFrame')?.timestamp).toBe(9_000)
  })

  it('a chained winner stays the holder: A ← B ← C where C’s shot won both', async () => {
    const { client } = buildParkedClientForTest()
    await client.park({ ...parkOrder({ trackId: 'B', kind: 'keyFrame' }), timestamp: 6_000 })
    await client.park({ ...parkOrder({ trackId: 'C', kind: 'keyFrame' }), timestamp: 7_000 })
    client.adopt('B', 'C', 'absorbed')
    client.adopt('A', 'B', 'absorbed')
    expect(client.info('A', 'keyFrame')?.timestamp).toBe(7_000)
  })

  it('a park still in flight at release is released when it lands', async () => {
    const { api, land } = heldParkApi()
    const client = createParkedFrameClient({ api, logger: makeLogRecorder().logger })
    const parked = client.park(parkOrder({ trackId: 'B', kind: 'keyFrame' }))
    client.adopt('A', 'B', 'absorbed')
    client.release('A')
    land()
    await parked
    await Promise.resolve()
    expect(client.info('B', 'keyFrame')).toBeUndefined()
    expect(api.rel.mock.calls.map(([input]) => input.trackId)).toContain('B')
  })

  it('evicting a fused survivor’s members is logged (L5)', () => {
    const rec = makeLogRecorder()
    const client = createParkedFrameClient({ api: makeApi(), logger: rec.logger })
    for (let i = 0; i <= 4096; i++) client.adopt(`S${i}`, `X${i}`, 'survivor')
    expect(rec.entries.map((e) => e.message)).toContain(
      'parked frame fusion record evicted at the bound',
    )
  })
})
