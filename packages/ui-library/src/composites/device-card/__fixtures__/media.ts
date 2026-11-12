/** The media player page of the approved mockup: five players, and the first one horizontal. */
import { remoteKeyOf } from '../shell/remote-keys'
import { DEFAULT_VOLUME_BOUNDS, type MediaCardModel, type MediaVolume } from '../scenes/media/model'
import type { CardOrientation, CardRemoteKey } from '../shell/model'
import { mockupCommon } from './common'

export interface MediaFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: MediaCardModel
}

const IT_KEYS: Readonly<Record<string, string>> = {
  power: 'Accensione',
  source_select: 'Sorgente',
  home: 'Home',
  up: 'Su',
  left: 'Sinistra',
  ok: 'OK',
  right: 'Destra',
  down: 'Giù',
  back: 'Indietro',
  menu: 'Menu',
  info: 'Info',
  volume_up: 'Vol',
  channel_up: 'Ch',
  volume_down: 'Vol',
  channel_down: 'Ch',
  mute: 'Muto',
  previous: 'Precedente',
  play_pause: 'Riproduci / pausa',
  next: 'Successivo',
}

/** The mockup's media remote: every key a TV remote declares. */
export const MEDIA_REMOTE: readonly CardRemoteKey[] = Object.entries(IT_KEYS).map(([role, label]) =>
  remoteKeyOf(role, label, (key) => key),
)

const volume = (level: number | null, muted = false): MediaVolume => ({
  level,
  muted,
  mutable: true,
  bounds: level === null ? null : DEFAULT_VOLUME_BOUNDS,
})

const common = (name: string, integration: string, watts: number): MediaCardModel['common'] => ({
  ...mockupCommon({
    name,
    integration,
    watts,
    supplyName: 'Presa TV',
    consumables: [],
    remote: MEDIA_REMOTE,
  }),
  battery: null,
  consumables: null,
})

const soggiorno = (orientation: CardOrientation): MediaFixture => ({
  id: orientation === 'horizontal' ? 'media-speaker-h' : 'media-speaker',
  caption: orientation === 'horizontal' ? 'Orizzontale' : 'Altoparlante',
  orientation,
  model: {
    common: common('Soggiorno', 'Sonos', 8),
    phase: 'playing',
    since: 'Spotify',
    artwork: 'music',
    imageUrl: null,
    artCaption: null,
    title: 'Blue in Green',
    subtitle: 'Miles Davis · Kind of Blue',
    power: { on: true },
    volume: volume(32),
    source: 'Spotify',
    sources: ['Spotify', 'Radio', 'Line-in', 'TV'],
    seek: { positionSec: 72, durationSec: 337 },
    transport: { previous: true, next: true, stop: false, blind: false },
    playback: null,
  },
})

export function mediaFixtures(): readonly MediaFixture[] {
  return [
    soggiorno('vertical'),
    {
      id: 'media-tv',
      caption: 'TV',
      orientation: 'vertical',
      model: {
        common: common('TV Sala', 'Samsung', 96),
        phase: 'on',
        since: 'HDMI 1',
        artwork: 'tv',
        imageUrl: null,
        artCaption: 'HDMI 1',
        title: 'Apple TV',
        subtitle: 'Sorgente HDMI 1',
        power: { on: true },
        volume: volume(18),
        source: 'HDMI 1 · Apple TV',
        sources: ['HDMI 1 · Apple TV', 'HDMI 2 · PlayStation', 'TV', 'Netflix'],
        seek: null,
        transport: { previous: false, next: false, stop: false, blind: false },
        playback: null,
      },
    },
    {
      id: 'media-amp',
      caption: 'Amplificatore · volume e riproduzione non noti',
      orientation: 'vertical',
      model: {
        common: common('Ampli', 'Infrarossi', 8),
        phase: 'on',
        since: 'Ottico',
        artwork: 'music',
        imageUrl: null,
        artCaption: null,
        title: null,
        subtitle: null,
        power: { on: true },
        volume: volume(null),
        source: 'Ottico',
        sources: ['Ottico', 'Bluetooth', 'Phono'],
        seek: null,
        transport: { previous: false, next: false, stop: true, blind: true },
        playback: null,
      },
    },
    {
      id: 'media-cec',
      caption: 'TV · contenuto non noto',
      orientation: 'vertical',
      model: {
        common: common('TV Camera', 'HDMI-CEC', 96),
        phase: 'on',
        since: null,
        artwork: 'blank',
        imageUrl: null,
        artCaption: null,
        title: null,
        subtitle: null,
        power: { on: true },
        volume: volume(12),
        source: null,
        sources: ['HDMI 1', 'HDMI 2', 'TV'],
        seek: null,
        transport: { previous: false, next: false, stop: true, blind: true },
        playback: null,
      },
    },
    {
      id: 'media-off',
      caption: 'Altoparlante · spento',
      orientation: 'vertical',
      model: {
        common: common('Cucina', 'Sonos', 0),
        phase: 'off',
        since: 'da 5 h',
        artwork: 'music',
        imageUrl: null,
        artCaption: null,
        title: 'Spento',
        subtitle: 'Ultima: Radio Deejay',
        power: { on: false },
        volume: volume(20),
        source: 'Radio',
        sources: ['Spotify', 'Radio', 'Line-in'],
        seek: null,
        transport: { previous: true, next: true, stop: false, blind: false },
        playback: null,
      },
    },
    soggiorno('horizontal'),
  ]
}
