import { DeviceFeature, type MediaPlayerStatus } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import { MediaPlayerCard } from '../scenes/media/MediaPlayerCard'
import { coarseDuration } from './coarse-duration'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import {
  mediaArtworkOf,
  mediaPhaseOf,
  mediaSeekOf,
  mediaSubtitleOf,
  mediaTransportOf,
  mediaVolumeOf,
  VOLUME_STEP,
} from './media-model'
import { useCardCommon } from './use-card-common'
import { presentCommand, reportedCall, reportedCommand } from './use-command-notice'

const clampVolume = (v: number): number => Math.min(100, Math.max(0, v))

/**
 * The media card of a real `media-player`: every control is drawn only when
 * the device declares it (its `DeviceFeature` flags); the remote overlay is
 * the device's own `remote` keys.
 */
export function ConnectedMediaCard({
  deviceId,
  canActuate = true,
  orientation,
  optimistic = true,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(
    dev?.mediaPlayer === undefined ? undefined : dev.state.mediaPlayer,
  )
  const { display, applyOptimisticAction } = useOptimisticSlice<MediaPlayerStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.mediaPlayer
  if (cap === undefined || display === undefined) return null
  const report = { fail: card.fail, succeed: card.succeed }
  const send = reportedCommand(applyOptimisticAction, report)
  const call = reportedCall(report)
  const features = card.features
  const declares = (f: DeviceFeature): boolean => features.includes(f)
  const phase = mediaPhaseOf(display)
  const volume = mediaVolumeOf(display, features)
  const level = display.volumeLevel
  const stepKeys = declares(DeviceFeature.MediaPlayerVolumeStep)
  const command = <I, R>(
    fn: ((input: I) => PromiseLike<R>) | undefined,
    method: string,
  ): ((input: I) => Promise<R>) => presentCommand(fn, 'media-player', method)
  const volumeBy = (delta: number): void => {
    if (stepKeys || level === null) {
      void call(() =>
        delta > 0
          ? command(cap.volumeUp, 'volumeUp')({ steps: 1 })
          : command(cap.volumeDown, 'volumeDown')({ steps: 1 }),
      )
      return
    }
    const next = clampVolume(level + delta)
    send({ volumeLevel: next, isMuted: false }, () =>
      command(cap.setVolume, 'setVolume')({ volumeLevel: next }),
    )
  }
  const shuffleOn = declares(DeviceFeature.MediaPlayerShuffle) ? display.shuffle : null
  const repeatOn = declares(DeviceFeature.MediaPlayerRepeat) ? display.repeat : null
  const media = display.currentMedia
  const on = phase !== 'off'
  return (
    <MediaPlayerCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        phase,
        since: on
          ? display.source.length > 0
            ? (display.source.split(' · ')[0] ?? null)
            : null
          : coarseDuration(Date.now() - display.lastChangedAt, t),
        artwork: mediaArtworkOf(display),
        imageUrl: media?.imageUrl ?? null,
        artCaption: display.source.length > 0 ? (display.source.split(' · ')[0] ?? null) : null,
        title: media?.title ?? null,
        subtitle: mediaSubtitleOf(display),
        power: declares(DeviceFeature.MediaPlayerPower) ? { on } : null,
        volume,
        source: display.source.length > 0 ? display.source : null,
        sources: declares(DeviceFeature.MediaPlayerSelectSource) ? display.availableSources : [],
        seek: mediaSeekOf(display, features),
        transport: mediaTransportOf(display, features),
        playback:
          shuffleOn === null && repeatOn === null ? null : { shuffle: shuffleOn, repeat: repeatOn },
      }}
      actions={{
        ...card.actions,
        onPower: (next) =>
          send({ state: next ? 'on' : 'off' }, () =>
            next ? command(cap.turnOn, 'turnOn')({}) : command(cap.turnOff, 'turnOff')({}),
          ),
        onVolumeUp: () => volumeBy(VOLUME_STEP),
        onVolumeDown: () => volumeBy(-VOLUME_STEP),
        onMute: (muted) =>
          send({ isMuted: muted }, () => command(cap.setMute, 'setMute')({ muted })),
        onSource: (source) =>
          send({ source }, () => command(cap.selectSource, 'selectSource')({ source })),
        onSeek: (sec) => {
          const position = Math.round(sec * 1000)
          send({ position, positionUpdatedAt: Date.now() }, () =>
            command(cap.seek, 'seek')({ position }),
          )
        },
        onPlay: () => send({ state: 'playing' }, () => cap.play({})),
        onPause: () => send({ state: 'paused' }, () => cap.pause({})),
        onStop: () => void call(() => command(cap.stop, 'stop')({})),
        onNext: () => void call(() => command(cap.next, 'next')({})),
        onPrevious: () => void call(() => command(cap.previous, 'previous')({})),
        onShuffle: (on) =>
          send({ shuffle: on }, () => command(cap.setShuffle, 'setShuffle')({ shuffle: on })),
        onRepeat: (repeat) =>
          send({ repeat }, () => command(cap.setRepeat, 'setRepeat')({ repeat })),
      }}
    />
  )
}
