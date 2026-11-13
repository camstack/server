import { describe, expect, it } from 'vitest'
import type { MediaPlayerStatus } from '../../../capabilities/media-player.cap.js'
import { DeviceFeature, DeviceType } from '../../device-type.js'
import { actionsOf, build, NOW, rowOf } from './hero-test-kit.js'

const PLAYING: MediaPlayerStatus = {
  state: 'playing',
  stateSource: 'reported',
  assumedFields: [],
  volumeLevel: 30,
  isMuted: false,
  source: '',
  availableSources: [],
  currentMedia: { type: 'music', title: 'Song' },
  position: 65_000,
  duration: 240_000,
  shuffle: false,
  repeat: 'all',
  positionUpdatedAt: NOW - 5_000,
  lastChangedAt: 1,
}

const FEATURES = [
  DeviceFeature.MediaPlayerPower,
  DeviceFeature.MediaPlayerNext,
  DeviceFeature.MediaPlayerPrevious,
  DeviceFeature.MediaPlayerShuffle,
  DeviceFeature.MediaPlayerRepeat,
]

const model = (features: readonly string[], slice: MediaPlayerStatus = PLAYING) =>
  build(DeviceType.MediaPlayer, ['media-player'], { 'media-player': slice }, features)

describe('media player transport extras', () => {
  it('offers shuffle as a toggle on setShuffle and repeat as a picker on setRepeat', () => {
    const controls = rowOf(model(FEATURES), 'playback').controls
    const shuffle = controls.find((c) => c.kind === 'toggle')
    expect(shuffle?.kind === 'toggle' && shuffle.on).toBe(false)
    expect(
      actionsOf(controls)
        .filter((a) => a.call.method === 'setShuffle')
        .map((a) => a.call.args),
    ).toEqual([{ shuffle: true }, { shuffle: false }])
    const repeat = controls.find((c) => c.kind === 'picker')
    expect(repeat?.kind === 'picker' && [repeat.current, repeat.options, repeat.valueArg]).toEqual([
      'all',
      ['off', 'all', 'one'],
      'repeat',
    ])
  })

  it('offers next and previous only when declared', () => {
    const declared = actionsOf(rowOf(model(FEATURES), 'playback').controls).map(
      (a) => a.call.method,
    )
    expect(declared).toEqual(expect.arrayContaining(['previous', 'next']))
    const bare = actionsOf(rowOf(model([DeviceFeature.MediaPlayerPower]), 'playback').controls).map(
      (a) => a.call.method,
    )
    expect(bare).not.toContain('next')
    expect(bare).not.toContain('previous')
  })

  it('draws neither shuffle nor repeat without the feature', () => {
    const controls = rowOf(model([DeviceFeature.MediaPlayerPower]), 'playback').controls
    expect(controls.some((c) => c.kind === 'toggle' || c.kind === 'picker')).toBe(false)
  })

  it('reads the position advanced to now against the duration', () => {
    const progress = model(FEATURES).facts.find((f) => f.id === 'progress')
    expect(progress?.text.en).toBe('1:10 / 4:00')
  })

  it('has no progress readout without a duration', () => {
    const m = model(FEATURES, { ...PLAYING, duration: null })
    expect(m.facts.some((f) => f.id === 'progress')).toBe(false)
  })
})

describe('media player mute', () => {
  const MUTE = [DeviceFeature.MediaPlayerMute]
  const muteOf = (slice: MediaPlayerStatus) =>
    rowOf(model(MUTE, slice), 'volume').controls.find(
      (c) =>
        (c.kind === 'toggle' && c.id === 'volume.mute') ||
        (c.kind === 'action' && c.action.id === 'volume.mute'),
    )

  it('a provider that reads the mute back offers a toggle that shows its state', () => {
    const control = muteOf({ ...PLAYING, isMuted: true, muteReadback: true })
    expect(control).toMatchObject({ kind: 'toggle', on: true })
  })

  it('without muteReadback a non-null isMuted is still a momentary key', () => {
    expect(muteOf({ ...PLAYING, isMuted: true })).toMatchObject({ kind: 'action' })
    expect(muteOf({ ...PLAYING, isMuted: true, muteReadback: false })).toMatchObject({
      kind: 'action',
    })
    expect(muteOf({ ...PLAYING, isMuted: null, muteReadback: true })).toMatchObject({
      kind: 'toggle',
      on: null,
    })
  })
})
