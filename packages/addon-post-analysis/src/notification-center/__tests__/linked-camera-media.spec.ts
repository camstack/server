import { describe, expect, it } from 'vitest'
import { linkedCameraMode, linkedMediaOwners } from '../linked-camera-media.js'
import type { NcLinkedStills } from '../linked-stills.js'

const stills: NcLinkedStills = {
  sensorId: 3243,
  cameraIds: [101, 102, 620],
  mosaicOwnerId: 'nc-mosaic:m',
  cameraOwnerIds: ['nc-linked:a', 'nc-linked:b', 'nc-linked:c'],
}

describe('linked camera media', () => {
  it('defaults to mosaic when the rule says nothing', () => {
    expect(linkedCameraMode({ attach: 'best' })).toBe('mosaic')
    expect(linkedCameraMode({ attach: 'best', linkedCameras: 'each' })).toBe('each')
  })

  it('mosaic: the composed picture is the still; the model gets the raw tiles', () => {
    expect(linkedMediaOwners(stills, 'mosaic')).toEqual({
      trackId: 'nc-mosaic:m',
      extraStills: [],
      analysisTiles: [
        { ownerId: 'nc-linked:a', cameraId: 101 },
        { ownerId: 'nc-linked:b', cameraId: 102 },
        { ownerId: 'nc-linked:c', cameraId: 620 },
      ],
    })
  })

  it('each: the primary camera leads, the others follow IN ORDER (a max-1 target keeps the first)', () => {
    expect(linkedMediaOwners(stills, 'each')).toEqual({
      trackId: 'nc-linked:a',
      // Each extra still carries the camera the SHELF photographed — its
      // position in `cameraIds`, never the row's `linkedCameraIds`.
      extraStills: [
        { ownerId: 'nc-linked:b', cameraId: 102 },
        { ownerId: 'nc-linked:c', cameraId: 620 },
      ],
      analysisTiles: [
        { ownerId: 'nc-linked:a', cameraId: 101 },
        { ownerId: 'nc-linked:b', cameraId: 102 },
        { ownerId: 'nc-linked:c', cameraId: 620 },
      ],
    })
  })
})
