import { describe, expect, it } from 'vitest'
import { mapPlayerInfoToStatus } from '../alexa-echo-state-to-cap.js'
import { parsePlayerState } from '../speak/worker-protocol.js'

/**
 * Whole `/api/np/player` bodies in the shapes Amazon sends for the sources an
 * Echo plays, run through the same two steps the device runs: parse the worker
 * answer, map it to the media-player slice.
 */
const NOW = 5_000

function slice(body: unknown) {
  return mapPlayerInfoToStatus(parsePlayerState(body), { online: true, now: NOW })
}

const amazonMusic = {
  playerInfo: {
    hint: null,
    infoText: {
      header: null,
      headerText: null,
      subText1: 'Daft Punk',
      subText2: 'Discovery',
      title: 'One More Time',
    },
    isPlayingInLemur: false,
    lemurVolume: null,
    mainArt: {
      altText: null,
      artType: 'URL',
      contentType: null,
      fullUrl: null,
      height: 0,
      url: 'https://m.media-amazon.com/images/I/discovery.jpg',
      width: 0,
    },
    miniArt: null,
    miniInfoText: null,
    progress: {
      allowScrubbing: true,
      locationInfo: null,
      mediaLength: 320,
      mediaProgress: 41,
      showTiming: true,
      visible: true,
    },
    provider: {
      providerDisplayName: 'Amazon Music',
      providerName: 'AMAZON_MUSIC',
      providerSubText: null,
    },
    state: 'PLAYING',
    template: 'DEFAULT',
    transport: {
      next: 'ENABLED',
      playPause: 'ENABLED',
      previous: 'ENABLED',
      repeat: 'UNSELECTED',
      shuffle: 'SELECTED',
    },
    volume: { muted: false, volume: 35 },
  },
}

const spotify = {
  playerInfo: {
    infoText: { header: null, subText1: 'Khruangbin', subText2: 'Mordechai', title: 'Time (You and I)' },
    mainArt: { url: 'https://i.scdn.co/image/abc' },
    progress: { mediaLength: 214, mediaProgress: 3 },
    provider: { providerDisplayName: 'Spotify', providerName: 'SPOTIFY' },
    state: 'PLAYING',
    transport: { repeat: 'DISABLED', shuffle: 'UNSELECTED' },
    volume: { muted: false, volume: 20 },
  },
}

/** Live radio: no album, the station is the title or only the sub text; length 0. */
const tuneInStation = {
  playerInfo: {
    infoText: { header: null, subText1: 'Radio Deejay', subText2: null, title: null },
    mainArt: { url: 'https://cdn-profiles.tunein.com/s1/logog.png' },
    progress: { mediaLength: 0, mediaProgress: 0 },
    provider: { providerDisplayName: 'TuneIn', providerName: 'TUNE_IN' },
    state: 'PLAYING',
    transport: { repeat: 'HIDDEN', shuffle: 'HIDDEN' },
    volume: { muted: false, volume: 40 },
  },
}

/** Only artwork and a provider: no text at all. */
const artOnly = {
  playerInfo: {
    infoText: null,
    mainArt: { url: 'https://example.com/cover.jpg' },
    provider: { providerDisplayName: 'Amazon Music', providerName: 'AMAZON_MUSIC' },
    state: 'PLAYING',
    volume: { muted: false, volume: 12 },
  },
}

describe('now playing from a real Echo body', () => {
  it('Amazon Music: title, artist, album, artwork, source, position and its read time', () => {
    expect(slice(amazonMusic)).toMatchObject({
      state: 'playing',
      source: 'Amazon Music',
      currentMedia: {
        title: 'One More Time',
        artist: 'Daft Punk',
        album: 'Discovery',
        imageUrl: 'https://m.media-amazon.com/images/I/discovery.jpg',
      },
      position: 41_000,
      positionUpdatedAt: NOW,
      shuffle: true,
      repeat: 'off',
    })
  })

  it('Spotify: media and source', () => {
    expect(slice(spotify)).toMatchObject({
      source: 'Spotify',
      currentMedia: { title: 'Time (You and I)', artist: 'Khruangbin' },
    })
  })

  it('TuneIn: a station named only in the first sub text still shows as now playing', () => {
    const status = slice(tuneInStation)
    expect(status.currentMedia).toMatchObject({
      title: 'Radio Deejay',
      imageUrl: 'https://cdn-profiles.tunein.com/s1/logog.png',
    })
    expect(status.source).toBe('TuneIn')
    expect(status.duration).toBeNull()
  })

  it('artwork with no text is still now playing, titled by its source', () => {
    expect(slice(artOnly).currentMedia).toMatchObject({
      title: 'Amazon Music',
      imageUrl: 'https://example.com/cover.jpg',
    })
  })

  it('a provider that is null leaves the source empty, never the string null', () => {
    expect(slice({ playerInfo: { ...spotify.playerInfo, provider: null } }).source).toBe('')
    expect(slice({ playerInfo: { ...spotify.playerInfo, provider: {} } }).source).toBe('')
  })

  it('the display name wins, the raw provider name is the fallback', () => {
    expect(
      slice({ playerInfo: { ...spotify.playerInfo, provider: { providerName: 'SPOTIFY' } } })
        .source,
    ).toBe('SPOTIFY')
  })

  it('one field of an unexpected type does not discard the title and artwork', () => {
    const status = slice({
      playerInfo: {
        ...amazonMusic.playerInfo,
        volume: { volume: 'loud', muted: 'no' },
        progress: { mediaLength: 'unknown', mediaProgress: null },
        transport: { shuffle: true, repeat: 7 },
        state: 'PLAYING',
      },
    })
    expect(status.currentMedia).toMatchObject({ title: 'One More Time' })
    expect(status.state).toBe('playing')
    expect(status.volumeLevel).toBeNull()
    expect(status.position).toBeNull()
    expect(status.positionUpdatedAt).toBeNull()
    expect(status.shuffle).toBeNull()
  })

  it('a text block of the wrong type does not discard the player state', () => {
    const status = slice({
      playerInfo: { ...amazonMusic.playerInfo, infoText: 'One More Time', mainArt: [] },
    })
    expect(status.state).toBe('playing')
    expect(status.currentMedia).toBeNull()
  })
})
