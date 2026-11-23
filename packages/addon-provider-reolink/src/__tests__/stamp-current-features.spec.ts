import type { CamStreamDescriptor } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { stampCurrentFeatures } from '../stamp-current-features.js'

describe('stampCurrentFeatures', () => {
  it('replaces a stale stored feature list with the current one (battery-operated without sleeps)', () => {
    const restored: CamStreamDescriptor = {
      camStreamId: 'native:main',
      kind: 'pull-rfc4571',
      label: 'main',
      url: 'lazy:rfc4571:native:main',
      autoEligible: true,
      deviceFeatures: ['battery-operated'],
    }
    const out = stampCurrentFeatures([restored], ['battery-operated', 'sleeps'])
    expect(out[0]!.deviceFeatures).toEqual(['battery-operated', 'sleeps'])
    expect(restored.deviceFeatures).toEqual(['battery-operated'])
    expect(out[0]!.label).toBe('main')
  })
})
