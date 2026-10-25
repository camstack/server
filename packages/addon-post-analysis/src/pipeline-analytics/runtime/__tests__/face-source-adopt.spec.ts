/**
 * D683 review M3: the absorbed piece's D644 face SOURCE parcel follows the
 * adoption — the survivor reads it when the absorbed face won, and the
 * survivor's release releases it.
 *
 * Disarms (each alone, restored):
 *  - drop `client.adopt` from the port's `adopt`: "the survivor reads the absorbed face parcel" fails;
 *  - drop the dims move from `FaceSourceFrameKeeper.adopt`: "a reused keyFrame's dims follow the winning face" fails.
 */
import { describe, expect, it } from 'vitest'
import { FaceSourceFrameKeeper, type HeldFaceGeometry } from '../../face-source-frame.js'
import { FaceSourceStats } from '../../face-source-stats.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { createFaceSourceParkPort, faceSourceParkKey } from '../face-source-park-port.js'
import { buildParkedClientForTest, HANDLE } from './parked-frame-test-helpers.js'

const geometry = (timestamp: number): HeldFaceGeometry => ({
  timestamp,
  bbox: { x: 100, y: 50, w: 20, h: 30 },
  frameWidth: 640,
  frameHeight: 360,
})

describe('face source parcels across a fusion (M3)', () => {
  it('the survivor reads the absorbed face parcel, and its release releases both', async () => {
    const { client, released } = buildParkedClientForTest()
    const port = createFaceSourceParkPort({
      client: () => client,
      isNodeOffline: () => false,
      logger: makeSilentLogger(),
    })
    port.park({ deviceId: 102, trackId: 'B', frameHandle: HANDLE, geometry: geometry(4000) })
    port.adopt('A', 'B', 'absorbed')
    const parcel = await port.take(102, 'A')
    expect(parcel?.timestamp).toBe(5_000) // the fake runner's answer for B's key
    port.release('A')
    expect(released()).toContain(faceSourceParkKey('B'))
  })

  it('a reused keyFrame’s dims follow the winning face', async () => {
    const keyFrames = new Map([['B', { timestamp: 1000, width: 3840, height: 2160 }]])
    const stored = new Map([['A', { mediaId: 77, timestamp: 1000 }]])
    const keeper = new FaceSourceFrameKeeper({
      port: {
        park: () => {},
        take: async () => null,
        release: () => {},
        adopt: () => {},
        trackKeyFrame: (trackId) => keyFrames.get(trackId),
      },
      media: {
        put: async () => 1,
        trackKeyFrame: async (trackId) => stored.get(trackId) ?? null,
      },
      stats: new FaceSourceStats(),
      logger: makeSilentLogger(),
    })
    const source = keeper.park({
      deviceId: 102,
      trackId: 'B',
      frameHandle: HANDLE,
      geometry: geometry(1000),
    })
    expect(source.mode).toBe('track-keyframe')
    keeper.adopt(102, 'A', 'B', 'absorbed')
    const persisted = await keeper.persist({
      deviceId: 102,
      trackId: 'A',
      faceId: 'face-A',
      source,
    })
    expect(persisted?.mediaId).toBe(77)
  })
})
