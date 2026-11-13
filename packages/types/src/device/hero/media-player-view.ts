/**
 * The state → view mapping of the media-player hero card, kept pure so it can
 * be specified without rendering.
 *
 * Two questions are answered separately. POWER is whether the device is on
 * (`off` / `standby` / on); RUNNING is what a powered device is doing
 * (`playing` / `paused` / `buffering` / `idle`). A status that never arrived
 * is `unknown` for both, and an unknown state is never drawn as off: it is
 * its own look. A state the driver only guesses (infrared has no feedback) is
 * marked `stateAssumed`, so a running-state reading outranks it.
 *
 * The controls are derived from what the device exposes — the status fields
 * it fills and the `DeviceFeature` flags it declares — never from a vendor.
 */
import type { MediaPlayerStatus } from '../../capabilities/media-player.cap.js'
import { DeviceFeature } from '../device-type.js'

export type PowerView = 'on' | 'off' | 'standby' | 'unknown'
/** `none` = powered but the device reports no activity (an infrared TV that is simply on). */
export type RunningView = 'playing' | 'paused' | 'buffering' | 'idle' | 'none' | 'unknown'
export type VolumeView = 'slider' | 'steps' | 'none'

/** Channel stepping: the device takes channel up / down; `current` is the channel it reports, when it does. */
export interface ChannelView {
  readonly current: string | null
}

export interface SourceView {
  readonly current: string
  readonly options: readonly string[]
  /** Several sources and the device can switch between them. */
  readonly selectable: boolean
}

export interface TransportView {
  /** Play / pause is drawn at all. */
  readonly playPause: boolean
  readonly previous: boolean
  readonly next: boolean
  readonly stop: boolean
}

/** What the device's `running-state` cap says: a reading, or `unknown` (null, unanswered or not bound). */
export type RunningReading = 'running' | 'idle' | 'unknown'

/** Readings from sibling caps bound to the same device; `undefined` = not bound or not answered. */
export interface MediaPlayerExtras {
  /** `running-state` slice's `running`. */
  readonly running?: boolean | null | undefined
}

/** What is playing, drawn whenever the device reports it — independent of the power reading. */
export interface NowPlayingView {
  readonly title: string | null
  /** Artist and album joined, as far as the device reports them. */
  readonly subtitle: string | null
  readonly artworkUrl: string | null
  /** The active source as plain text (`Spotify`); null when none is reported. */
  readonly source: string | null
  /** Position and duration in ms, both known and the duration positive; null otherwise. */
  readonly progress: { readonly positionMs: number; readonly durationMs: number } | null
}

/**
 * A status that may carry the instant its `position` was read (ms epoch); a status
 * without it keeps the position where it was reported.
 */
export type PositionStampedStatus = MediaPlayerStatus & {
  readonly positionUpdatedAt?: number | null
}

/** The position to show at `nowMs`: the reported one, advanced while playing when it is stamped. */
export function projectedPositionMs(status: PositionStampedStatus, nowMs: number): number | null {
  if (status.position === null) return null
  const stamp = status.positionUpdatedAt
  if (status.state !== 'playing' || typeof stamp !== 'number') return status.position
  const advanced = status.position + Math.max(0, nowMs - stamp)
  return status.duration !== null && status.duration > 0
    ? Math.min(advanced, status.duration)
    : advanced
}

/**
 * The optimistic patch for a seek. A status that carries `positionUpdatedAt` is stamped
 * too: the projection advances from the stamp, so leaving the old one would show a
 * position past the target.
 */
export function seekPatch(
  status: PositionStampedStatus,
  positionMs: number,
  nowMs: number,
): Partial<PositionStampedStatus> {
  return typeof status.positionUpdatedAt === 'number'
    ? { position: positionMs, positionUpdatedAt: nowMs }
    : { position: positionMs }
}

/** True when the status carries a stamp the position can be advanced from. */
export function isPositionTicking(status: PositionStampedStatus | undefined): boolean {
  return (
    status !== undefined &&
    status.state === 'playing' &&
    status.position !== null &&
    typeof status.positionUpdatedAt === 'number'
  )
}

export interface MediaPlayerView {
  readonly power: PowerView
  /** The `running-state` cap's reading; `unknown` when the cap is absent or has no answer. */
  readonly runningReading: RunningReading
  readonly running: RunningView
  /** The power / running state is the driver's own bookkeeping, not a reading. */
  readonly stateAssumed: boolean
  /** Power can be switched from here. */
  readonly canSwitchPower: boolean
  readonly transport: TransportView
  readonly seek: boolean
  readonly volume: VolumeView
  /** The device reported a level; false draws the slider as unknown. */
  readonly volumeKnown: boolean
  /** True only when the status sets `muteReadback`. Absent or false is not a reading. */
  readonly muteKnown: boolean
  /** Artwork of what is playing; null when there is none. */
  readonly artworkUrl: string | null
  /** A mute control is offered; a toggle only when `muteKnown`, else a momentary key. */
  readonly mute: boolean
  readonly source: SourceView | null
  /** Channel up / down is offered; null when the device does not declare channel stepping. */
  readonly channel: ChannelView | null
  readonly shuffle: boolean
  readonly repeat: boolean
  /** The device reports a shuffle / repeat value it cannot be told to change: drawn, not pressable. */
  readonly shuffleReadOnly: boolean
  readonly repeatReadOnly: boolean
  /** Title, artist, artwork, source and progress of what plays; null when the device reports none. */
  readonly nowPlaying: NowPlayingView | null
}

const NO_TRANSPORT: TransportView = { playPause: false, previous: false, next: false, stop: false }

/** Whether the status carries any activity the device actually reported. */
function runningOf(state: MediaPlayerStatus['state'] | undefined): RunningView {
  switch (state) {
    case 'playing':
    case 'paused':
    case 'buffering':
    case 'idle':
      return state
    case undefined:
      return 'unknown'
    default:
      return 'none'
  }
}

function artworkOf(status: MediaPlayerStatus): string | null {
  const url = status.currentMedia?.imageUrl?.trim() ?? ''
  return url === '' ? null : url
}

function powerOf(state: MediaPlayerStatus['state'] | undefined): PowerView {
  if (state === undefined) return 'unknown'
  if (state === 'off') return 'off'
  if (state === 'standby') return 'standby'
  return 'on'
}

/**
 * A slice from before `assumedFields` existed (stateSource assumed, no list)
 * means the whole state is a guess; with a list, only the named fields are.
 */
function isAssumed(
  status: MediaPlayerStatus,
  field: MediaPlayerStatus['assumedFields'][number],
): boolean {
  if (status.stateSource !== 'assumed') return false
  const listed = status.assumedFields ?? []
  return listed.length === 0 || listed.includes(field)
}

const UNKNOWN_VIEW: MediaPlayerView = {
  power: 'unknown',
  runningReading: 'unknown',
  running: 'unknown',
  stateAssumed: false,
  canSwitchPower: false,
  transport: NO_TRANSPORT,
  seek: false,
  volume: 'none',
  volumeKnown: false,
  muteKnown: false,
  artworkUrl: null,
  mute: false,
  source: null,
  channel: null,
  shuffle: false,
  repeat: false,
  shuffleReadOnly: false,
  repeatReadOnly: false,
  nowPlaying: null,
}

function nowPlayingOf(status: MediaPlayerStatus | undefined): NowPlayingView | null {
  if (status === undefined) return null
  const media = status.currentMedia
  const title = media?.title.trim() ?? ''
  const subtitle = [media?.artist, media?.album]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join(' · ')
  const artworkUrl = artworkOf(status)
  const source = typeof status.source === 'string' ? status.source.trim() : ''
  const hasDuration = status.position !== null && status.duration !== null && status.duration > 0
  if (title === '' && subtitle === '' && artworkUrl === null) return null
  return {
    title: title === '' ? null : title,
    subtitle: subtitle === '' ? null : subtitle,
    artworkUrl,
    source: source === '' ? null : source,
    progress:
      hasDuration && status.position !== null && status.duration !== null
        ? { positionMs: status.position, durationMs: status.duration }
        : null,
  }
}

function readingOf(running: boolean | null | undefined): RunningReading {
  if (running === true) return 'running'
  if (running === false) return 'idle'
  return 'unknown'
}

export function deriveMediaPlayerView(
  status: MediaPlayerStatus | undefined,
  features: readonly string[] | undefined,
  extras: MediaPlayerExtras = {},
): MediaPlayerView {
  const view = derivePowerGatedView(status, features, extras)
  // What plays is data the device reported: it is never hidden behind the power reading.
  return {
    ...view,
    nowPlaying: nowPlayingOf(status),
    shuffleReadOnly:
      status !== undefined &&
      status.shuffle !== null &&
      !(features?.includes(DeviceFeature.MediaPlayerShuffle) ?? false),
    repeatReadOnly:
      status !== undefined &&
      status.repeat !== null &&
      !(features?.includes(DeviceFeature.MediaPlayerRepeat) ?? false),
  }
}

function derivePowerGatedView(
  status: MediaPlayerStatus | undefined,
  features: readonly string[] | undefined,
  extras: MediaPlayerExtras,
): MediaPlayerView {
  const runningReading = readingOf(extras.running)
  const view = deriveFromStatus(status, features)
  // A reading from a running source outranks the driver's guess (and fills a missing status).
  const guessed = status === undefined || status.state === undefined || view.stateAssumed
  if (runningReading === 'unknown' || !guessed) return { ...view, runningReading }
  if (runningReading === 'idle') {
    const off = { ...UNKNOWN_VIEW, power: 'off' as const, running: 'none' as const }
    return { ...off, canSwitchPower: view.canSwitchPower, runningReading }
  }
  // Running: the device is on whatever the guess said; its other controls follow.
  const powered =
    status === undefined
      ? view
      : deriveFromStatus(
          status.state === undefined || status.state === 'off' || status.state === 'standby'
            ? { ...status, state: 'on' }
            : status,
          features,
        )
  return { ...powered, power: 'on', stateAssumed: false, runningReading }
}

/** The channel being watched: only a media item the device itself calls a channel. */
function channelOf(status: MediaPlayerStatus): string | null {
  const media = status.currentMedia
  if (media === null || media === undefined || media.type !== 'channel') return null
  const title = media.title.trim()
  return title === '' ? null : title
}

function deriveFromStatus(
  status: MediaPlayerStatus | undefined,
  features: readonly string[] | undefined,
): MediaPlayerView {
  const has = (f: DeviceFeature): boolean => features?.includes(f) ?? false
  const canSwitchPower = has(DeviceFeature.MediaPlayerPower)
  // No status, or a status that carries no state: nothing is known, so nothing is drawn as on.
  if (status === undefined || status.state === undefined) {
    return { ...UNKNOWN_VIEW, canSwitchPower }
  }

  const power = powerOf(status.state)
  const running = runningOf(status.state)
  const base: MediaPlayerView = {
    ...UNKNOWN_VIEW,
    power,
    running,
    stateAssumed: isAssumed(status, 'state'),
    canSwitchPower,
  }
  // Nothing but the power switch is offered while the device is off or in standby.
  if (power !== 'on') return base

  const hasTransportFeature =
    has(DeviceFeature.MediaPlayerNext) ||
    has(DeviceFeature.MediaPlayerPrevious) ||
    has(DeviceFeature.MediaPlayerStop) ||
    has(DeviceFeature.MediaPlayerSeek)
  // A declared volume is always drawn: a device that has not reported a level yet
  // gets the slider in its "unknown level" state, never no slider.
  const volume: VolumeView = has(DeviceFeature.MediaPlayerVolume)
    ? 'slider'
    : has(DeviceFeature.MediaPlayerVolumeStep)
      ? 'steps'
      : 'none'
  const sourceName = typeof status.source === 'string' ? status.source.trim() : ''
  const options = status.availableSources ?? []
  const hasSource = sourceName !== '' || options.length > 0

  return {
    ...base,
    transport: {
      playPause: running !== 'none' || hasTransportFeature,
      previous: has(DeviceFeature.MediaPlayerPrevious),
      next: has(DeviceFeature.MediaPlayerNext),
      stop: has(DeviceFeature.MediaPlayerStop),
    },
    seek: has(DeviceFeature.MediaPlayerSeek) && status.duration !== null && status.duration > 0,
    volume,
    // A declared mute is drawn even with no reading (its state then reads unknown, not "unmuted");
    // a device that declares nothing but reports a mute next to a slider keeps the toggle.
    mute: has(DeviceFeature.MediaPlayerMute) || (volume === 'slider' && status.isMuted !== null),
    volumeKnown: status.volumeLevel !== null,
    muteKnown: status.muteReadback === true,
    artworkUrl: artworkOf(status),
    source: hasSource
      ? {
          current: sourceName,
          options,
          selectable: has(DeviceFeature.MediaPlayerSelectSource) && options.length > 1,
        }
      : null,
    channel: has(DeviceFeature.MediaPlayerChannelStep) ? { current: channelOf(status) } : null,
    shuffle: has(DeviceFeature.MediaPlayerShuffle) && status.shuffle !== null,
    repeat: has(DeviceFeature.MediaPlayerRepeat) && status.repeat !== null,
  }
}
