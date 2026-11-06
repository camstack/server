import { DeviceFeature, type MediaPlayerStatus } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { deriveMediaPlayerView, projectedPositionMs } from '../media-player-view'

const BASE: MediaPlayerStatus = {
  state: 'off',
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
  lastChangedAt: 0,
}

const ALL = [
  DeviceFeature.MediaPlayerPower,
  DeviceFeature.MediaPlayerVolume,
  DeviceFeature.MediaPlayerVolumeStep,
  DeviceFeature.MediaPlayerMute,
  DeviceFeature.MediaPlayerSelectSource,
  DeviceFeature.MediaPlayerNext,
  DeviceFeature.MediaPlayerPrevious,
  DeviceFeature.MediaPlayerStop,
  DeviceFeature.MediaPlayerSeek,
  DeviceFeature.MediaPlayerShuffle,
  DeviceFeature.MediaPlayerRepeat,
]

describe('power and running', () => {
  it('an unanswered status is unknown, never off', () => {
    const view = deriveMediaPlayerView(undefined, ALL)
    expect(view.power).toBe('unknown')
    expect(view.running).toBe('unknown')
    expect(view.volume).toBe('none')
    expect(view.source).toBeNull()
    expect(view.transport.playPause).toBe(false)
  })

  it.each([
    ['off', 'off', 'none'],
    ['standby', 'standby', 'none'],
    ['on', 'on', 'none'],
    ['idle', 'on', 'idle'],
    ['playing', 'on', 'playing'],
    ['paused', 'on', 'paused'],
    ['buffering', 'on', 'buffering'],
  ] as const)('state %s is power %s, running %s', (state, power, running) => {
    const view = deriveMediaPlayerView({ ...BASE, state }, ALL)
    expect(view.power).toBe(power)
    expect(view.running).toBe(running)
  })

  it('offers only the power switch while off or in standby', () => {
    const status = { ...BASE, state: 'standby' as const, volumeLevel: 30, source: 'HDMI 1' }
    const view = deriveMediaPlayerView(status, ALL)
    expect(view.canSwitchPower).toBe(true)
    expect(view.volume).toBe('none')
    expect(view.source).toBeNull()
    expect(view.transport.playPause).toBe(false)
  })

  it('does not offer a power switch the device does not declare', () => {
    expect(deriveMediaPlayerView(BASE, []).canSwitchPower).toBe(false)
  })
})

describe('assumed state', () => {
  it('a reported status is a reading', () => {
    expect(deriveMediaPlayerView({ ...BASE, state: 'on' }, ALL).stateAssumed).toBe(false)
  })

  it('names only the guessed fields', () => {
    const view = deriveMediaPlayerView(
      {
        ...BASE,
        state: 'on',
        stateSource: 'assumed',
        assumedFields: ['isMuted'],
        isMuted: false,
        volumeLevel: 10,
      },
      ALL,
    )
    expect(view.stateAssumed).toBe(false)
    expect(view.muteAssumed).toBe(true)
    expect(view.volumeAssumed).toBe(false)
  })

  it('an older assumed slice with no field list is assumed throughout', () => {
    const view = deriveMediaPlayerView({ ...BASE, state: 'on', stateSource: 'assumed' }, ALL)
    expect(view.stateAssumed).toBe(true)
  })
})

describe('controls come from what the device exposes', () => {
  const on = { ...BASE, state: 'playing' as const }

  it('a volume reading draws the slider, with a mute toggle once mute is known', () => {
    const view = deriveMediaPlayerView({ ...on, volumeLevel: 40, isMuted: false }, ALL)
    expect(view.volume).toBe('slider')
    expect(view.mute).toBe(true)
  })

  it('no reading but a step feature draws steps; neither draws nothing', () => {
    expect(deriveMediaPlayerView(on, [DeviceFeature.MediaPlayerVolumeStep]).volume).toBe('steps')
    expect(deriveMediaPlayerView(on, []).volume).toBe('none')
  })

  it('a declared volume is drawn even when no level was reported (unknown, not hidden)', () => {
    const view = deriveMediaPlayerView(on, [DeviceFeature.MediaPlayerVolume])
    expect(view.volume).toBe('slider')
    expect(view.volumeKnown).toBe(false)
    expect(
      deriveMediaPlayerView({ ...on, volumeLevel: 0 }, [DeviceFeature.MediaPlayerVolume]),
    ).toMatchObject({
      volume: 'slider',
      volumeKnown: true,
    })
  })

  it('a declared mute is drawn with no reading; an undeclared one needs a reading', () => {
    const declared = deriveMediaPlayerView(on, [DeviceFeature.MediaPlayerMute])
    expect(declared).toMatchObject({ mute: true, muteKnown: false })
    expect(deriveMediaPlayerView(on, [DeviceFeature.MediaPlayerVolume]).mute).toBe(false)
    expect(
      deriveMediaPlayerView({ ...on, isMuted: false }, [DeviceFeature.MediaPlayerVolume]).mute,
    ).toBe(true)
  })

  it('artwork is the current media image, nothing when blank or absent', () => {
    const media = { type: 'music', title: 'Song' }
    expect(
      deriveMediaPlayerView(
        { ...on, currentMedia: { ...media, imageUrl: ' https://example.com/a.jpg ' } },
        ALL,
      ).artworkUrl,
    ).toBe('https://example.com/a.jpg')
    expect(
      deriveMediaPlayerView({ ...on, currentMedia: { ...media, imageUrl: ' ' } }, ALL).artworkUrl,
    ).toBeNull()
    expect(deriveMediaPlayerView({ ...on, currentMedia: media }, ALL).artworkUrl).toBeNull()
    expect(deriveMediaPlayerView(on, ALL).artworkUrl).toBeNull()
  })

  it('an unknown mute is flagged unknown, not unmuted', () => {
    const view = deriveMediaPlayerView({ ...on, volumeLevel: 40, isMuted: null }, ALL)
    expect(view.muteKnown).toBe(false)
  })

  it('a source is selectable only with several options and the feature', () => {
    const status = { ...on, source: 'HDMI 1', availableSources: ['HDMI 1', 'HDMI 2'] }
    expect(deriveMediaPlayerView(status, ALL).source?.selectable).toBe(true)
    expect(deriveMediaPlayerView(status, []).source?.selectable).toBe(false)
    expect(deriveMediaPlayerView({ ...on, source: 'HDMI 1' }, ALL).source).toEqual({
      current: 'HDMI 1',
      options: [],
      selectable: false,
    })
    expect(deriveMediaPlayerView(on, ALL).source).toBeNull()
  })

  it('seek needs a known duration; shuffle and repeat need a value', () => {
    expect(deriveMediaPlayerView({ ...on, duration: 1000 }, ALL).seek).toBe(true)
    expect(deriveMediaPlayerView(on, ALL).seek).toBe(false)
    expect(deriveMediaPlayerView({ ...on, shuffle: false, repeat: 'all' }, ALL)).toMatchObject({
      shuffle: true,
      repeat: true,
    })
    expect(deriveMediaPlayerView(on, ALL)).toMatchObject({ shuffle: false, repeat: false })
  })

  it('a powered device with no activity and no transport feature has no play button', () => {
    const view = deriveMediaPlayerView({ ...BASE, state: 'on' }, [DeviceFeature.MediaPlayerPower])
    expect(view.transport.playPause).toBe(false)
  })
})

describe('sibling reading: running-state', () => {
  const infrared = { ...BASE, state: 'standby' as const, stateSource: 'assumed' as const }

  it('is unknown when the running-state cap is absent', () => {
    const view = deriveMediaPlayerView(infrared, ALL)
    expect(view.runningReading).toBe('unknown')
    expect(view.power).toBe('standby')
  })

  it('a running reading outranks the assumed state: running means on', () => {
    const view = deriveMediaPlayerView(infrared, ALL, { running: true })
    expect(view.runningReading).toBe('running')
    expect(view.power).toBe('on')
    expect(view.stateAssumed).toBe(false)
  })

  it('an idle reading means off; it fills a status that never arrived', () => {
    expect(
      deriveMediaPlayerView({ ...BASE, state: 'on', stateSource: 'assumed' }, ALL, {
        running: false,
      }).power,
    ).toBe('off')
    const view = deriveMediaPlayerView(undefined, ALL, { running: false })
    expect(view).toMatchObject({ power: 'off', runningReading: 'idle' })
  })

  it('a null reading changes nothing', () => {
    const view = deriveMediaPlayerView(infrared, ALL, { running: null })
    expect(view.runningReading).toBe('unknown')
    expect(view.power).toBe('standby')
    expect(view.stateAssumed).toBe(true)
  })

  it('a reported state is not overridden by a running reading', () => {
    const view = deriveMediaPlayerView({ ...BASE, state: 'off' }, ALL, { running: true })
    expect(view.power).toBe('off')
  })

  it('a status that carries no state is unknown power and unknown running, never on', () => {
    const stateless = JSON.parse('{"stateSource":"reported","assumedFields":[]}')
    const view = deriveMediaPlayerView(stateless, ALL)
    expect(view.power).toBe('unknown')
    expect(view.running).toBe('unknown')
    expect(view.runningReading).toBe('unknown')
  })

  it('a stateless status takes its power from a running-state reading that answered', () => {
    const stateless = JSON.parse('{"stateSource":"reported","assumedFields":[]}')
    expect(deriveMediaPlayerView(stateless, ALL, { running: true }).power).toBe('on')
    expect(deriveMediaPlayerView(stateless, ALL, { running: false }).power).toBe('off')
  })
})

describe('now playing and projected position', () => {
  const base: MediaPlayerStatus = {
    state: 'playing',
    stateSource: 'reported',
    assumedFields: [],
    volumeLevel: null,
    isMuted: null,
    source: 'Spotify',
    availableSources: [],
    currentMedia: { type: 'music', title: 'Song', artist: 'Band', album: 'Record' },
    position: 10_000,
    duration: 100_000,
    shuffle: null,
    repeat: null,
    lastChangedAt: 0,
  }

  it('is derived from the status whatever the power reading says', () => {
    const view = deriveMediaPlayerView({ ...base, state: 'standby' }, [])
    expect(view.nowPlaying).toMatchObject({
      title: 'Song',
      subtitle: 'Band · Record',
      source: 'Spotify',
      progress: { positionMs: 10_000, durationMs: 100_000 },
    })
  })

  it('is null when the device reports no media', () => {
    expect(deriveMediaPlayerView({ ...base, currentMedia: null }, []).nowPlaying).toBeNull()
  })

  it('advances a stamped position only while playing, and clamps to the duration', () => {
    const stamped = { ...base, positionUpdatedAt: 1_000 }
    expect(projectedPositionMs(stamped, 6_000)).toBe(15_000)
    expect(projectedPositionMs(stamped, 1_000_000)).toBe(100_000)
    expect(projectedPositionMs({ ...stamped, state: 'paused' }, 6_000)).toBe(10_000)
    expect(projectedPositionMs(base, 6_000)).toBe(10_000)
  })
})
