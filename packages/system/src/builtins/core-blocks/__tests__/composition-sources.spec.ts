import { describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import {
  describeCompositionSources,
  normalizedNativeOwner,
  type BoundCapView,
  type CompositionSourcePorts,
} from '../composition-sources.js'

const CAMERA = { addonId: 'provider-hikvision', stableId: 'camera-101' }
const CAMERA_ID = 101

function ports(bindings: readonly BoundCapView[]): CompositionSourcePorts {
  return {
    listByAddon: async () => [
      { id: CAMERA_ID, stableId: CAMERA.stableId, type: DeviceType.Camera },
    ],
    bindings: async () => bindings,
  }
}

describe('normalizedNativeOwner', () => {
  it.each([undefined, null, '', '   '])('does not classify %j as native ownership', (owner) => {
    expect(normalizedNativeOwner(owner)).toBeNull()
  })

  it('trims a real owner', () => {
    expect(normalizedNativeOwner(' provider-reolink ')).toBe('provider-reolink')
  })
})

describe('describeCompositionSources native ownership', () => {
  it.each([
    undefined,
    null,
    '',
    '   ',
  ])('does not classify %j as native ownership', async (nativeAddonId) => {
    const descriptions = await describeCompositionSources(
      ports([{ capName: 'doorbell', nativeAddonId }]),
      [],
      [CAMERA],
    )
    const target = descriptions.targets.get('provider-hikvision/camera-101')

    expect(target?.kind).toBe('found')
    if (target?.kind === 'found') expect(target.nativeCaps.has('doorbell')).toBe(false)
  })

  it('classifies a real owner after trimming', async () => {
    const descriptions = await describeCompositionSources(
      ports([{ capName: 'doorbell', nativeAddonId: ' provider-reolink ' }]),
      [],
      [CAMERA],
    )
    const target = descriptions.targets.get('provider-hikvision/camera-101')

    expect(target?.kind).toBe('found')
    if (target?.kind === 'found') expect(target.nativeCaps.get('doorbell')).toBe('provider-reolink')
  })
})
