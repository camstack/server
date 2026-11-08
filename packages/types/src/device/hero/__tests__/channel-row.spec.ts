import { describe, expect, it } from 'vitest'
import type { MediaPlayerStatus } from '../../../capabilities/media-player.cap.js'
import { DeviceFeature, DeviceType } from '../../device-type.js'
import { actionsOf, build, rowOf } from './hero-test-kit.js'

const ON: MediaPlayerStatus = {
  state: 'idle',
  stateSource: 'reported',
  assumedFields: [],
  volumeLevel: null,
  isMuted: null,
  source: '',
  availableSources: [],
  currentMedia: null,
  position: null,
  duration: null,
  shuffle: null,
  repeat: null,
  positionUpdatedAt: null,
  lastChangedAt: 1,
}

const withChannel = [DeviceFeature.MediaPlayerPower, DeviceFeature.MediaPlayerChannelStep]

describe('media player channel row', () => {
  it('a channel-stepping player offers channel down and up on the media-player cap', () => {
    const m = build(DeviceType.MediaPlayer, ['media-player'], { 'media-player': ON }, withChannel)
    const calls = actionsOf(rowOf(m, 'channel').controls).map((a) => [
      a.id,
      a.call.cap,
      a.call.method,
    ])
    expect(calls).toEqual([
      ['channel.down', 'media-player', 'channelDown'],
      ['channel.up', 'media-player', 'channelUp'],
    ])
  })

  it('shows the current channel when the device reports one', () => {
    const m = build(
      DeviceType.MediaPlayer,
      ['media-player'],
      { 'media-player': { ...ON, currentMedia: { type: 'channel', title: 'Rai 1' } } },
      withChannel,
    )
    expect(rowOf(m, 'channel').status?.en).toBe('Rai 1')
  })

  it('does not invent a channel: an unreported one leaves the status empty', () => {
    const m = build(DeviceType.MediaPlayer, ['media-player'], { 'media-player': ON }, withChannel)
    expect(rowOf(m, 'channel').status).toBeNull()
  })

  it('a title that is not a channel is not shown as one', () => {
    const m = build(
      DeviceType.MediaPlayer,
      ['media-player'],
      { 'media-player': { ...ON, currentMedia: { type: 'music', title: 'Song' } } },
      withChannel,
    )
    expect(rowOf(m, 'channel').status).toBeNull()
  })

  it('no row without the channel-step feature', () => {
    const m = build(DeviceType.MediaPlayer, ['media-player'], { 'media-player': ON }, [
      DeviceFeature.MediaPlayerPower,
    ])
    expect(m.rows.some((r) => r.id === 'channel')).toBe(false)
  })

  it('no row while the player is off', () => {
    const m = build(
      DeviceType.MediaPlayer,
      ['media-player'],
      { 'media-player': { ...ON, state: 'off' } },
      withChannel,
    )
    expect(m.rows.some((r) => r.id === 'channel')).toBe(false)
  })
})
