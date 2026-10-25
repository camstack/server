/**
 * Review H4: a fused track's parcels stay reachable. The absorbed piece's
 * parked keyFrame is the survivor's when the merged ranking chose it, and both
 * pieces' parcels are released when the survivor closes — never at fusion.
 *
 * Disarms (each alone, restored):
 *  - make `adopt` a no-op: "the survivor reads the absorbed piece's parcel" fails;
 *  - make `release` release only the id it is given: "releasing the survivor releases both" fails.
 */
import { describe, expect, it } from 'vitest'
import { buildParkedClientForTest, parkOrder } from './parked-frame-test-helpers.js'

describe('ParkedFrameClient.adopt', () => {
  it('the survivor reads the absorbed piece parcel when its best shot was chosen', async () => {
    const { client } = buildParkedClientForTest()
    await client.park(parkOrder({ trackId: 'B', kind: 'keyFrame' }))
    client.adopt('A', 'B', 'absorbed')
    expect(client.info('A', 'keyFrame')).toEqual(client.info('B', 'keyFrame'))
  })

  it('releasing the survivor releases both', async () => {
    const { client, released } = buildParkedClientForTest()
    await client.park(parkOrder({ trackId: 'A', kind: 'thumbnail' }))
    await client.park(parkOrder({ trackId: 'B', kind: 'keyFrame' }))
    client.adopt('A', 'B', 'absorbed')
    client.release('A')
    expect(released().toSorted()).toEqual(['A', 'B'])
  })
})
