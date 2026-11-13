/** Pure mapping from a `media-player` slice and the device's features to the media scene. */
import { DeviceFeature, type MediaPlayerStatus } from '@camstack/types'
import type { MediaArtworkKind } from '../illustrations/MediaArtwork'
import {
  DEFAULT_VOLUME_BOUNDS,
  type MediaPhase,
  type MediaSeek,
  type MediaTransport,
  type MediaVolume,
  type MediaVolumeBounds,
} from '../scenes/media/model'

const PHASE: Readonly<Record<MediaPlayerStatus['state'], MediaPhase>> = {
  off: 'off',
  standby: 'off',
  on: 'on',
  idle: 'on',
  playing: 'playing',
  buffering: 'playing',
  paused: 'paused',
}

export function mediaPhaseOf(status: MediaPlayerStatus): MediaPhase {
  return PHASE[status.state]
}

const VIDEO_TYPES: ReadonlySet<string> = new Set([
  'video',
  'tvshow',
  'movie',
  'episode',
  'channel',
  'tv',
  'app',
  'game',
])

export function mediaArtworkOf(status: MediaPlayerStatus): MediaArtworkKind {
  const media = status.currentMedia
  if (media === null) return status.source.length > 0 ? 'tv' : 'blank'
  return VIDEO_TYPES.has(media.type.toLowerCase()) ? 'tv' : 'music'
}

export function mediaSubtitleOf(status: MediaPlayerStatus): string | null {
  const media = status.currentMedia
  if (media === null) return null
  const parts = [media.artist, media.album].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  )
  return parts.length === 0 ? null : parts.join(' · ')
}

const has = (features: readonly string[], f: DeviceFeature): boolean => features.includes(f)

export interface MediaVolumeOptions {
  /** The binding implements `setVolume`. */
  readonly absolute: boolean
  /** The device's declared range. Absent: 0..100 step 1. */
  readonly bounds?: MediaVolumeBounds | null
}

/** The volume block: shown when the player declares a volume level or volume keys. */
export function mediaVolumeOf(
  status: MediaPlayerStatus,
  features: readonly string[],
  options: MediaVolumeOptions = { absolute: false },
): MediaVolume | null {
  const reports = has(features, DeviceFeature.MediaPlayerVolume)
  const steps = has(features, DeviceFeature.MediaPlayerVolumeStep)
  if (!reports && !steps) return null
  const muteReadback = status.muteReadback === true
  const reported = reports && typeof status.volumeLevel === 'number' ? status.volumeLevel : null
  const bounds =
    reported !== null && options.absolute ? (options.bounds ?? DEFAULT_VOLUME_BOUNDS) : null
  return {
    level: reported,
    muted: muteReadback && status.isMuted === true,
    muteReadback,
    mutable: has(features, DeviceFeature.MediaPlayerMute),
    bounds,
  }
}

/** The position, read from where the player reported it and how long it has played since. */
export function mediaSeekOf(
  status: MediaPlayerStatus,
  features: readonly string[],
  now: number = Date.now(),
): MediaSeek | null {
  if (!has(features, DeviceFeature.MediaPlayerSeek)) return null
  if (status.duration === null || status.duration <= 0 || status.position === null) return null
  const elapsed =
    status.state === 'playing' && status.positionUpdatedAt !== null
      ? Math.max(0, now - status.positionUpdatedAt)
      : 0
  return {
    positionSec: Math.min(status.duration, status.position + elapsed) / 1000,
    durationSec: status.duration / 1000,
  }
}

export function mediaTransportOf(
  status: MediaPlayerStatus,
  features: readonly string[],
): MediaTransport {
  return {
    previous: has(features, DeviceFeature.MediaPlayerPrevious),
    next: has(features, DeviceFeature.MediaPlayerNext),
    stop: has(features, DeviceFeature.MediaPlayerStop),
    blind: status.stateSource === 'assumed' || status.assumedFields.includes('state'),
  }
}
