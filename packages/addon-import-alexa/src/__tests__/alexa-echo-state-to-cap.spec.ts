import { describe, expect, it } from 'vitest'
import { mapPlayerInfoToStatus } from '../alexa-echo-state-to-cap.js'
import { PlayerInfoSchema } from '../speak/worker-protocol.js'

const NOW = 1_000

const playing = PlayerInfoSchema.parse({
  state: 'PLAYING',
  volume: { volume: 32, muted: false },
  infoText: { title: 'Song', subText1: 'Artist', subText2: 'Album' },
  mainArt: { url: 'https://example.com/art.jpg' },
  progress: { mediaLength: 200, mediaProgress: 12.5 },
  transport: { shuffle: 'SELECTED', repeat: 'UNSELECTED' },
})

describe('mapPlayerInfoToStatus', () => {
  it('maps a playing player', () => {
    const status = mapPlayerInfoToStatus(playing, { online: true, now: NOW })
    expect(status).toMatchObject({
      state: 'playing',
      volumeLevel: 32,
      isMuted: false,
      position: 12_500,
      duration: 200_000,
      shuffle: true,
      repeat: 'off',
      lastChangedAt: NOW,
      currentMedia: {
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        imageUrl: 'https://example.com/art.jpg',
      },
    })
  })

  it('maps paused and idle', () => {
    expect(mapPlayerInfoToStatus({ state: 'PAUSED' }, { online: true, now: NOW }).state).toBe(
      'paused',
    )
    expect(mapPlayerInfoToStatus({ state: 'IDLE' }, { online: true, now: NOW }).state).toBe('idle')
  })

  it('an empty playerInfo is idle with every reading null, never 0', () => {
    const status = mapPlayerInfoToStatus({}, { online: true, now: NOW })
    expect(status).toMatchObject({
      state: 'idle',
      volumeLevel: null,
      isMuted: null,
      currentMedia: null,
      position: null,
      duration: null,
      shuffle: null,
      repeat: null,
    })
  })

  it('an offline Echo is off with nothing read, whatever it last played', () => {
    const status = mapPlayerInfoToStatus(playing, { online: false, now: NOW })
    expect(status.state).toBe('off')
    expect(status.volumeLevel).toBeNull()
    expect(status.currentMedia).toBeNull()
  })

  it('HIDDEN shuffle and repeat are null; a live stream has no duration', () => {
    const status = mapPlayerInfoToStatus(
      {
        transport: { shuffle: 'HIDDEN', repeat: 'HIDDEN' },
        progress: { mediaLength: 0 },
      },
      { online: true, now: NOW },
    )
    expect(status.shuffle).toBeNull()
    expect(status.repeat).toBeNull()
    expect(status.duration).toBeNull()
  })

  it('a volume of 0 is a reading, a missing volume is not', () => {
    expect(
      mapPlayerInfoToStatus({ volume: { volume: 0 } }, { online: true, now: NOW }).volumeLevel,
    ).toBe(0)
    expect(mapPlayerInfoToStatus({ volume: {} }, { online: true, now: NOW }).volumeLevel).toBeNull()
  })

  it('an empty title is no media', () => {
    expect(
      mapPlayerInfoToStatus({ infoText: { title: '' } }, { online: true, now: NOW }).currentMedia,
    ).toBeNull()
  })
})
