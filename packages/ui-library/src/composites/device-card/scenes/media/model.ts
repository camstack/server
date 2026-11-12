import type { MediaPlayerRepeat } from '@camstack/types'
import type { MediaArtworkKind } from '../../illustrations/MediaArtwork'
import type { CardCommon, CardCommonActions } from '../../shell/model'

/** What the player is doing, as the card words it. */
export type MediaPhase = 'off' | 'on' | 'playing' | 'paused'

export interface MediaVolume {
  /** 0..100, or null when the player does not report it (an IR amplifier). */
  readonly level: number | null
  readonly muted: boolean
  /** The device binds a mute command. */
  readonly mutable: boolean
}

export interface MediaSeek {
  readonly positionSec: number
  readonly durationSec: number
}

/**
 * Shuffle and repeat. A side is null when that feature is not declared or
 * the player has not reported a value.
 */
export interface MediaPlayback {
  readonly shuffle: boolean | null
  readonly repeat: MediaPlayerRepeat | null
}

export interface MediaTransport {
  readonly previous: boolean
  readonly next: boolean
  readonly stop: boolean
  /**
   * The player does not report its playback state (IR, CEC): play, pause and
   * stop are separate keys, sent blind, instead of one play/pause toggle.
   */
  readonly blind: boolean
}

export interface MediaCardModel {
  readonly common: CardCommon
  readonly phase: MediaPhase
  readonly since: string | null
  readonly artwork: MediaArtworkKind
  readonly imageUrl: string | null
  /** What a TV tile names (its input). */
  readonly artCaption: string | null
  readonly title: string | null
  readonly subtitle: string | null
  /** Null when the device binds no power commands. */
  readonly power: { readonly on: boolean } | null
  readonly volume: MediaVolume | null
  readonly source: string | null
  /** The inputs it can switch to; empty when it binds no source selection. */
  readonly sources: readonly string[]
  readonly seek: MediaSeek | null
  readonly transport: MediaTransport | null
  /** Null when the device declares neither: they sit in the remote sheet, not on the scene. */
  readonly playback: MediaPlayback | null
}

export interface MediaCardActions extends CardCommonActions {
  readonly onPower: (on: boolean) => void
  readonly onVolumeUp: () => void
  readonly onVolumeDown: () => void
  readonly onMute: (muted: boolean) => void
  readonly onSource: (source: string) => void
  readonly onSeek: (positionSec: number) => void
  readonly onPlay: () => void
  readonly onPause: () => void
  readonly onStop: () => void
  readonly onNext: () => void
  readonly onPrevious: () => void
  readonly onShuffle: (on: boolean) => void
  readonly onRepeat: (repeat: MediaPlayerRepeat) => void
}

const NEXT_REPEAT: Readonly<Record<MediaPlayerRepeat, MediaPlayerRepeat>> = {
  off: 'all',
  all: 'one',
  one: 'off',
}

/** The next repeat mode, in the order the old control cycled them. */
export function nextMediaRepeat(repeat: MediaPlayerRepeat): MediaPlayerRepeat {
  return NEXT_REPEAT[repeat]
}

/** "1:12". */
export function formatTrackTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
