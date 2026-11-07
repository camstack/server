/**
 * Pure mapping from an Echo's `playerInfo` (`/api/np/player`) to the
 * `media-player` cap's status. No I/O, no alexapy: unit-testable on fixtures.
 *
 * A value Amazon did not send is null, never 0 (D393): a silent speaker has no
 * volume reading, not volume 0.
 */
import type { MediaPlayerRepeat, MediaPlayerState, MediaPlayerStatus } from '@camstack/types'
import type { DeviceVolume, PlayerInfo } from './speak/worker-protocol.js'

export interface EchoStatusInput {
  /** Whether Amazon lists the Echo as online. An offline Echo is `off`, whatever it last played. */
  readonly online: boolean
  readonly now: number
}

/** The slice of an Echo that cannot be read: every reading null, the state as given. */
export function emptyEchoStatus(state: MediaPlayerState, now: number): MediaPlayerStatus {
  return {
    state,
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
    lastChangedAt: now,
  }
}

export function mapEchoPlaybackState(value: string | null | undefined): MediaPlayerState {
  switch (value) {
    case 'PLAYING':
      return 'playing'
    case 'PAUSED':
      return 'paused'
    case 'BUFFERING':
      return 'buffering'
    default:
      return 'idle'
  }
}

/** Whether a player answer carries any playback: an active state, a text or artwork. */
export function hasPlayback(info: PlayerInfo): boolean {
  if (mapEchoPlaybackState(info.state) !== 'idle') return true
  return nonEmpty(info.infoText?.title) !== null || nonEmpty(info.mainArt?.url) !== null
}

function percent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(Math.max(0, Math.min(100, value)))
}

function secondsToMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value * 1000)
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** `SELECTED` is on, `UNSELECTED` is off; `HIDDEN` and `DISABLED` mean the surface does not exist. */
function shuffleOf(value: string | null | undefined): boolean | null {
  if (value === 'SELECTED') return true
  if (value === 'UNSELECTED') return false
  return null
}

function repeatOf(value: string | null | undefined): MediaPlayerRepeat | null {
  if (value === 'SELECTED') return 'all'
  if (value === 'UNSELECTED') return 'off'
  return null
}

/** The streaming service playing: its display name, else its raw name; empty when Amazon names none. */
function sourceOf(info: PlayerInfo): string {
  return nonEmpty(info.provider?.providerDisplayName) ?? nonEmpty(info.provider?.providerName) ?? ''
}

/**
 * What is playing. Amazon puts the title in `infoText.title`, but a radio station
 * often names itself only in the first sub text, and some players send artwork and
 * a provider with no text at all: each still counts as now playing. Nothing to
 * title it by (no text, and artwork with no provider name) is null.
 */
function currentMediaOf(info: PlayerInfo): MediaPlayerStatus['currentMedia'] {
  const first = nonEmpty(info.infoText?.title)
  const second = nonEmpty(info.infoText?.subText1)
  const imageUrl = nonEmpty(info.mainArt?.url)
  const album = nonEmpty(info.infoText?.subText2)
  const title = first ?? second ?? (imageUrl !== null ? nonEmpty(sourceOf(info)) : null)
  // Artwork with nothing to call it by cannot be titled: no media rather than an empty title.
  if (title === null) return null
  // With a real title the first sub text is the artist; promoted to the title it is not repeated.
  const artist = first !== null ? second : null
  return {
    type: 'unknown',
    title,
    ...(artist !== null ? { artist } : {}),
    ...(album !== null ? { album } : {}),
    ...(imageUrl !== null ? { imageUrl } : {}),
  }
}

export function mapPlayerInfoToStatus(info: PlayerInfo, input: EchoStatusInput): MediaPlayerStatus {
  if (!input.online) return emptyEchoStatus('off', input.now)
  const length = secondsToMs(info.progress?.mediaLength)
  const position = secondsToMs(info.progress?.mediaProgress)
  return {
    ...emptyEchoStatus(mapEchoPlaybackState(info.state), input.now),
    volumeLevel: percent(info.volume?.volume),
    isMuted: typeof info.volume?.muted === 'boolean' ? info.volume.muted : null,
    source: sourceOf(info),
    currentMedia: currentMediaOf(info),
    position,
    positionUpdatedAt: position === null ? null : input.now,
    // A live stream reports a length of 0: no duration, not a zero-length track.
    duration: length === 0 ? null : length,
    shuffle: shuffleOf(info.transport?.shuffle),
    repeat: repeatOf(info.transport?.repeat),
  }
}

/**
 * Fill the volume and mute the player read left null from the account's volume
 * list. The player read wins when it has a value; a value neither source has stays null.
 */
export function withListedVolume(
  status: MediaPlayerStatus,
  listed: DeviceVolume | undefined,
): MediaPlayerStatus {
  if (listed === undefined) return status
  return {
    ...status,
    volumeLevel: status.volumeLevel ?? percent(listed.volume),
    isMuted: status.isMuted ?? listed.muted,
  }
}
