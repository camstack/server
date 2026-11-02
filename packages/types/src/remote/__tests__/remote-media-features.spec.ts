import { describe, expect, it } from 'vitest'
import { DeviceFeature } from '../../device/device-type.js'
import { mediaPlayerFeaturesOfRoles } from '../remote-media-features.js'

describe('mediaPlayerFeaturesOfRoles', () => {
  it('derives the surface from what is bound, never from what a TV could do', () => {
    expect(mediaPlayerFeaturesOfRoles(['power', 'volume_up', 'volume_down', 'channel_up'])).toEqual(
      [
        DeviceFeature.MediaPlayerPower,
        DeviceFeature.MediaPlayerVolumeStep,
        DeviceFeature.MediaPlayerChannelStep,
      ],
    )
  })

  it('offers sources for a custom or input button, and nothing for an empty remote', () => {
    expect(mediaPlayerFeaturesOfRoles(['custom:netflix'])).toEqual([
      DeviceFeature.MediaPlayerSelectSource,
    ])
    expect(mediaPlayerFeaturesOfRoles(['input'])).toEqual([DeviceFeature.MediaPlayerSelectSource])
    expect(mediaPlayerFeaturesOfRoles([])).toEqual([])
  })
})
