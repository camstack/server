import { describe, it, expect } from 'vitest'
import {
  NcMediaPolicySchema,
  NcRulePatchSchema,
  NcLinkedCameraModeSchema,
} from '../notification-rules.cap.js'

describe('media.linkedCameras', () => {
  it('accepts mosaic and each', () => {
    expect(NcMediaPolicySchema.parse({ attach: 'best', linkedCameras: 'each' }).linkedCameras).toBe(
      'each',
    )
    expect(NcLinkedCameraModeSchema.options).toEqual(['mosaic', 'each'])
  })

  it('stays ABSENT when not sent — the default is applied in code, never materialised', () => {
    expect(NcMediaPolicySchema.parse({ attach: 'best' }).linkedCameras).toBeUndefined()
    const patch = NcRulePatchSchema.parse({ media: { attach: 'best' } })
    expect(patch.media?.linkedCameras).toBeUndefined()
  })

  it('rejects an unknown mode', () => {
    expect(() => NcMediaPolicySchema.parse({ attach: 'best', linkedCameras: 'grid' })).toThrow()
  })
})
