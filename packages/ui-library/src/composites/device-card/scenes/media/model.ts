import type { MediaPlayerRepeat } from '@camstack/types'
import type { MediaArtworkKind } from '../../illustrations/MediaArtwork'
import type { CardCommon, CardCommonActions } from '../../shell/model'

/** What the player is doing, as the card words it. */
export type MediaPhase = 'off' | 'on' | 'playing' | 'paused'

/** The discrete scale of an absolute volume. The cap default is 0..100, step 1. */
export interface MediaVolumeBounds {
  readonly min: number
  readonly max: number
  readonly step: number
}

/** Used when the device reports a level and declares no tighter range. */
export const DEFAULT_VOLUME_BOUNDS: MediaVolumeBounds = { min: 0, max: 100, step: 1 }

export interface MediaVolume {
  /** The reported level, or null when the player does not report it (an IR amplifier). */
  readonly level: number | null
  readonly muted: boolean
  /** The device binds a mute command. */
  readonly mutable: boolean
  /**
   * The slider's scale when the player reports a level and implements an
   * absolute set. Null: the − / + keys (the level is unknown, or only
   * volume up/down exist).
   */
  readonly bounds: MediaVolumeBounds | null
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
  /** Absolute level, sent once when the slider is released. */
  readonly onVolume: (level: number) => void
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
