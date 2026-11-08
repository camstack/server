import { describe, expect, it } from 'vitest'
import { DeviceFeature } from '../../device/device-type.js'
import { mediaPlayerFeaturesOfRoles } from '../remote-media-features.js'

describe('mediaPlayerFeaturesOfRoles', () => {
  it('derives the surface from what is bound, never from what a TV could do', () => {
    expect(
      mediaPlayerFeaturesOfRoles(['power', 'volume_up', 'volume_down', 'channel_up'], 0),
    ).toEqual([
      DeviceFeature.MediaPlayerPower,
      DeviceFeature.MediaPlayerVolumeStep,
      DeviceFeature.MediaPlayerChannelStep,
    ])
  })

  it('offers a source surface only for declared sources, never for a bound button', () => {
    expect(mediaPlayerFeaturesOfRoles(['custom:netflix', 'input'], 0)).toEqual([])
    expect(mediaPlayerFeaturesOfRoles(['custom:netflix'], 1)).toEqual([
      DeviceFeature.MediaPlayerSelectSource,
    ])
    expect(mediaPlayerFeaturesOfRoles([], 0)).toEqual([])
  })
})
