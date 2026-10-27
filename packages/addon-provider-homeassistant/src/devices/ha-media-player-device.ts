import {
  mediaPlayerCapability,
  type DeviceContext,
  type InferNativeProvider,
  type MediaPlayerStatus,
  type MediaPlayerState,
  type MediaPlayerRepeat,
  RUNNING_STATE_COLD,
  type RunningStateStatus,
  runningFromMediaPlayer,
  runningStateCapability,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: MediaPlayerStatus = {
  state: 'off',
  volumeLevel: null,
  isMuted: null,
  source: '',
  availableSources: [],
  currentMedia: null,
  position: null,
  duration: null,
  shuffle: null,
  repeat: null,
  lastChangedAt: 0,
}

/**
 * HA-backed media player. Single `media-player` cap with the full
 * 12-method surface. HA's media_player.* attributes are extensive —
 * we decode the common ones; unsupported fields stay null in the slice.
 */
export class HaMediaPlayerDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerMediaPlayerCap()
    this.registerRunningCap()
    this.runtimeState.setCapState('media-player', COLD_START)
    this.runtimeState.setCapState('running-state', RUNNING_STATE_COLD)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const attrs = state.attributes

    const playerState = mapHaMediaPlayerState(state.state)
    const slice: MediaPlayerStatus = {
      state: playerState ?? 'off',
      volumeLevel: readVolumeAsPercent(attrs),
      isMuted: readBooleanAttr(attrs, 'is_volume_muted'),
      source: readStringAttr(attrs, 'source') ?? '',
      availableSources: readStringArray(attrs, 'source_list'),
      currentMedia: buildCurrentMedia(attrs),
      position: readDurationMs(attrs, 'media_position'),
      duration: readDurationMs(attrs, 'media_duration'),
      shuffle: readBooleanAttr(attrs, 'shuffle'),
      repeat: readRepeat(attrs['repeat']),
      lastChangedAt,
    }
    this.runtimeState.setCapState('media-player', slice)
    const fetchedAt = Date.now()
    const previous = this.runtimeState.getCapState<RunningStateStatus>('running-state')
    this.runtimeState.setCapState(
      'running-state',
      runningFromMediaPlayer(playerState, previous, fetchedAt, lastChangedAt),
    )
  }

  private registerRunningCap(): void {
    const provider: InferNativeProvider<typeof runningStateCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<RunningStateStatus>('running-state') ?? RUNNING_STATE_COLD,
    }
    this.ctx.registerNativeCap(runningStateCapability, provider)
  }

  private registerMediaPlayerCap(): void {
    const provider: InferNativeProvider<typeof mediaPlayerCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<MediaPlayerStatus>('media-player') ?? COLD_START
      },
      play: async () => {
        await this.callHaService('media_player', 'media_play')
      },
      pause: async () => {
        await this.callHaService('media_player', 'media_pause')
      },
      stop: async () => {
        await this.callHaService('media_player', 'media_stop')
      },
      next: async () => {
        await this.callHaService('media_player', 'media_next_track')
      },
      previous: async () => {
        await this.callHaService('media_player', 'media_previous_track')
      },
      seek: async ({ position: positionMs }) => {
        await this.callHaService('media_player', 'media_seek', { seek_position: positionMs / 1000 })
      },
      setVolume: async ({ volumeLevel }) => {
        // HA volume_level is 0..1; cap is 0..100.
        await this.callHaService('media_player', 'volume_set', { volume_level: volumeLevel / 100 })
      },
      setMute: async ({ muted }) => {
        await this.callHaService('media_player', 'volume_mute', { is_volume_muted: muted })
      },
      setShuffle: async ({ shuffle }) => {
        await this.callHaService('media_player', 'shuffle_set', { shuffle })
      },
      setRepeat: async ({ repeat }) => {
        await this.callHaService('media_player', 'repeat_set', { repeat })
      },
      selectSource: async ({ source }) => {
        await this.callHaService('media_player', 'select_source', { source })
      },
      playMedia: async ({ mediaId, mediaType }) => {
        await this.callHaService('media_player', 'play_media', {
          media_content_id: mediaId,
          media_content_type: mediaType,
        })
      },
    }
    this.ctx.registerNativeCap(mediaPlayerCapability, provider)
  }
}

function mapHaMediaPlayerState(s: string): MediaPlayerState | null {
  switch (s) {
    case 'off':
      return 'off'
    case 'on':
      return 'on'
    case 'idle':
      return 'idle'
    case 'playing':
      return 'playing'
    case 'paused':
      return 'paused'
    case 'buffering':
      return 'buffering'
    case 'standby':
      return 'standby'
    default:
      return null
  }
}

function readVolumeAsPercent(attrs: Record<string, unknown>): number | null {
  const v = attrs['volume_level']
  if (typeof v !== 'number') return null
  return Math.max(0, Math.min(100, Math.round(v * 100)))
}

function readDurationMs(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key]
  // HA reports duration / position in SECONDS (float).
  return typeof v === 'number' ? Math.round(v * 1000) : null
}

function readRepeat(v: unknown): MediaPlayerRepeat | null {
  return v === 'off' || v === 'all' || v === 'one' ? v : null
}

function buildCurrentMedia(attrs: Record<string, unknown>): MediaPlayerStatus['currentMedia'] {
  const title = readStringAttr(attrs, 'media_title')
  if (!title) return null
  return {
    type: readStringAttr(attrs, 'media_content_type') ?? 'unknown',
    title,
    ...(typeof attrs['media_artist'] === 'string'
      ? { artist: attrs['media_artist'] as string }
      : {}),
    ...(typeof attrs['media_album_name'] === 'string'
      ? { album: attrs['media_album_name'] as string }
      : {}),
    ...(typeof attrs['entity_picture'] === 'string'
      ? { imageUrl: attrs['entity_picture'] as string }
      : {}),
  }
}

function readStringAttr(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key]
  return typeof v === 'string' ? v : null
}
function readStringArray(attrs: Record<string, unknown>, key: string): string[] {
  const v = attrs[key]
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string')
}
function readBooleanAttr(attrs: Record<string, unknown>, key: string): boolean | null {
  const v = attrs[key]
  return typeof v === 'boolean' ? v : null
}
