/**
 * Pure mapping from an Echo's `playerInfo` (`/api/np/player`) to the
 * `media-player` cap's status. No I/O, no alexapy: unit-testable on fixtures.
 *
 * A value Amazon did not send is null, never 0 (D393): a silent speaker has no
 * volume reading, not volume 0.
 */
import type { MediaPlayerRepeat, MediaPlayerState, MediaPlayerStatus } from '@camstack/types'
import type { PlayerInfo } from './speak/worker-protocol.js'

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

function currentMediaOf(info: PlayerInfo): MediaPlayerStatus['currentMedia'] {
  const title = nonEmpty(info.infoText?.title)
  if (title === null) return null
  const artist = nonEmpty(info.infoText?.subText1)
  const album = nonEmpty(info.infoText?.subText2)
  const imageUrl = nonEmpty(info.mainArt?.url)
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
  return {
    ...emptyEchoStatus(mapEchoPlaybackState(info.state), input.now),
    volumeLevel: percent(info.volume?.volume),
    isMuted: typeof info.volume?.muted === 'boolean' ? info.volume.muted : null,
    currentMedia: currentMediaOf(info),
    position: secondsToMs(info.progress?.mediaProgress),
    // A live stream reports a length of 0: no duration, not a zero-length track.
    duration: length === 0 ? null : length,
    shuffle: shuffleOf(info.transport?.shuffle),
    repeat: repeatOf(info.transport?.repeat),
  }
}
