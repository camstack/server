import type { MediaPlayerRepeat } from '@camstack/types'
import type { ReactElement, ReactNode } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { MediaArtwork } from '../../illustrations/MediaArtwork'
import { CardButton } from '../../parts/CardButton'
import { MenuButton } from '../../parts/MenuButton'
import { HorizontalSlider } from '../../parts/sliders'
import { type BottomRow, rowButtons, rowSelector, rowSlider } from '../../shell/bottom-rows'
import { type ColumnItem, columnButton, columnSlider, columnValue } from '../../shell/column-items'
import { DeviceCard, type DeviceCardView } from '../../shell/DeviceCard'
import { ScenePower } from '../../shell/ScenePower'
import type { CardOrientation, CardTone } from '../../shell/model'
import {
  formatTrackTime,
  type MediaCardActions,
  type MediaCardModel,
  type MediaPhase,
  type MediaPlayback,
  type MediaVolume,
  nextMediaRepeat,
} from './model'

export interface MediaPlayerCardProps {
  readonly model: MediaCardModel
  readonly actions: MediaCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
  /** Opens the remote sheet. The shot harness uses it; a card starts on the scene. */
  readonly initialView?: DeviceCardView
}

const TONE: Readonly<Record<MediaPhase, CardTone>> = {
  off: 'muted',
  on: 'primary',
  playing: 'primary',
  paused: 'warning',
}

export function mediaPhaseLabel(phase: MediaPhase, t: UiTextFn): string {
  switch (phase) {
    case 'off':
      return t('uiLibrary.deviceCard.media.off', 'Off')
    case 'on':
      return t('uiLibrary.deviceCard.media.on', 'On')
    case 'playing':
      return t('uiLibrary.deviceCard.media.playing', 'Playing')
    case 'paused':
      return t('uiLibrary.deviceCard.media.paused', 'Paused')
  }
}

function volumeItems(
  v: MediaVolume,
  off: boolean,
  actions: MediaCardActions,
  t: UiTextFn,
): readonly ColumnItem[] {
  const bounds = v.bounds
  const level: readonly ColumnItem[] =
    bounds !== null && v.level !== null
      ? [
          columnSlider('volume', {
            value: v.level,
            min: bounds.min,
            max: bounds.max,
            step: bounds.step,
            ariaLabel: t('uiLibrary.deviceCard.media.volume', 'Volume'),
            disabled: off,
            onCommit: actions.onVolume,
            testId: 'dc-media-volume',
          }),
          columnValue('volume-level', {
            value: String(v.level),
            tone: off ? 'muted' : 'primary',
            testId: 'dc-media-volume-level',
          }),
        ]
      : [
          columnButton('volume-up', {
            glyph: 'plus',
            label: t('uiLibrary.deviceCard.media.volumeUp', 'Volume up'),
            disabled: off,
            onPress: actions.onVolumeUp,
            testId: 'dc-media-volume-up',
          }),
          columnValue('volume-level', {
            value: v.level === null ? '—' : String(v.level),
            ...(v.level === null ? {} : { caption: t('uiLibrary.deviceCard.media.vol', 'vol') }),
            tone: off || v.level === null ? 'muted' : 'primary',
            testId: 'dc-media-volume',
          }),
          columnButton('volume-down', {
            glyph: 'minus',
            label: t('uiLibrary.deviceCard.media.volumeDown', 'Volume down'),
            disabled: off,
            onPress: actions.onVolumeDown,
            testId: 'dc-media-volume-down',
          }),
        ]
  return [
    ...level,
    ...(v.mutable
      ? [
          columnButton('mute', {
            glyph: 'mute',
            label: t('uiLibrary.deviceCard.media.mute', 'Mute'),
            tone: v.muteReadback && v.muted ? 'on' : 'default',
            pressed: v.muteReadback ? v.muted : undefined,
            disabled: off,
            testId: 'dc-media-mute',
            onPress: () => actions.onMute(v.muteReadback ? !v.muted : true),
          }),
        ]
      : []),
  ]
}

function transportButtons(
  model: MediaCardModel,
  actions: MediaCardActions,
  t: UiTextFn,
): readonly ReactElement[] {
  const tr = model.transport
  if (tr === null) return []
  const off = model.phase === 'off'
  const play = t('uiLibrary.deviceCard.media.play', 'Play')
  const pause = t('uiLibrary.deviceCard.pause', 'Pause')
  if (tr.blind) {
    const stop = t('uiLibrary.deviceCard.stop', 'Stop')
    return [
      <CardButton
        key="play"
        glyph="play"
        aria-label={play}
        title={play}
        disabled={off}
        onClick={actions.onPlay}
      />,
      <CardButton
        key="pause"
        glyph="pause"
        aria-label={pause}
        title={pause}
        disabled={off}
        onClick={actions.onPause}
      />,
      ...(tr.stop
        ? [
            <CardButton
              key="stop"
              glyph="stop"
              aria-label={stop}
              title={stop}
              disabled={off}
              onClick={actions.onStop}
            />,
          ]
        : []),
    ]
  }
  const playing = model.phase === 'playing'
  return [
    ...(tr.previous
      ? [
          <CardButton
            key="previous"
            glyph="previous"
            aria-label={t('uiLibrary.deviceCard.media.previous', 'Previous')}
            disabled={off}
            onClick={actions.onPrevious}
          />,
        ]
      : []),
    <CardButton
      key="play"
      glyph={playing ? 'pause' : 'play'}
      tone="primary"
      aria-label={playing ? pause : play}
      title={playing ? pause : play}
      disabled={off}
      data-testid="dc-media-play"
      onClick={playing ? actions.onPause : actions.onPlay}
    />,
    ...(tr.next
      ? [
          <CardButton
            key="next"
            glyph="next"
            aria-label={t('uiLibrary.deviceCard.media.next', 'Next')}
            disabled={off}
            onClick={actions.onNext}
          />,
        ]
      : []),
  ]
}

function repeatWord(repeat: MediaPlayerRepeat, t: UiTextFn): string {
  switch (repeat) {
    case 'off':
      return t('uiLibrary.mediaPlayerPanel.repeatOff', 'Off')
    case 'all':
      return t('uiLibrary.mediaPlayerPanel.repeatAll', 'All')
    case 'one':
      return t('uiLibrary.mediaPlayerPanel.repeatOne', 'One')
  }
}

/** Shuffle and repeat, for the remote sheet. Null when the device declares neither. */
function playbackExtra(
  playback: MediaPlayback | null,
  off: boolean,
  actions: MediaCardActions,
  t: UiTextFn,
): ReactNode {
  if (playback === null) return null
  if (playback.shuffle === null && playback.repeat === null) return null
  const repeat = playback.repeat
  return (
    <div className="flex flex-wrap justify-center gap-2" data-testid="dc-media-playback">
      {playback.shuffle === null ? null : (
        <CardButton
          tone={playback.shuffle ? 'on' : 'default'}
          aria-pressed={playback.shuffle}
          disabled={off}
          data-testid="dc-media-shuffle"
          onClick={() => actions.onShuffle(!playback.shuffle)}
        >
          {t('uiLibrary.mediaPlayerPanel.shuffle', 'Shuffle')}
        </CardButton>
      )}
      {repeat === null ? null : (
        <CardButton
          tone={repeat === 'off' ? 'default' : 'on'}
          disabled={off}
          data-testid="dc-media-repeat"
          onClick={() => actions.onRepeat(nextMediaRepeat(repeat))}
        >
          {t('uiLibrary.mediaPlayerPanel.repeat', 'Repeat')}: {repeatWord(repeat, t)}
        </CardButton>
      )}
    </div>
  )
}

function bottomRows(
  model: MediaCardModel,
  actions: MediaCardActions,
  t: UiTextFn,
): readonly BottomRow[] {
  const seek = model.seek
  const transport = transportButtons(model, actions, t)
  const sourceLabel = t('uiLibrary.deviceCard.media.source', 'Source')
  return [
    ...(seek === null
      ? []
      : [
          rowSlider('seek', {
            slider: (
              <HorizontalSlider
                value={seek.positionSec}
                min={0}
                max={Math.max(1, seek.durationSec)}
                ariaLabel={t('uiLibrary.deviceCard.media.position', 'Position in the track')}
                disabled={model.phase === 'off'}
                label={formatTrackTime(seek.positionSec)}
                trailing={formatTrackTime(seek.durationSec)}
                fill
                onCommit={actions.onSeek}
                testId="dc-media-seek"
              />
            ),
          }),
        ]),
    ...(transport.length === 0
      ? []
      : [rowButtons('transport', { buttons: transport, testId: 'dc-media-transport' })]),
    ...(model.sources.length === 0
      ? []
      : [
          rowSelector('source', {
            control: (
              <MenuButton
                options={model.sources.map((s) => ({ id: s, label: s }))}
                value={model.source}
                onChange={actions.onSource}
                ariaLabel={sourceLabel}
                triggerLabel={sourceLabel}
                disabled={model.phase === 'off'}
                testId="dc-media-source"
              />
            ),
          }),
        ]),
  ]
}

/**
 * A media player: the volume on the left, what is playing in the middle (its
 * cover, a TV's input, or nothing when the content is not known), power on the
 * right, the track position, the transport and the source picker below. A
 * player whose only control is power turns on and off by a tap on the scene. A
 * player that cannot report its playback gets blind play / pause / stop keys.
 */
export function MediaPlayerCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
  initialView = 'scene',
}: MediaPlayerCardProps): ReactElement {
  const t = useUiText()
  const on = model.phase !== 'off'
  const label = mediaPhaseLabel(model.phase, t)
  const volume = model.volume === null ? [] : volumeItems(model.volume, !on, actions, t)
  const bottom = bottomRows(model, actions, t)
  /** Power is the only control: the drawing is the switch. */
  const powerOnly = model.power !== null && volume.length === 0 && bottom.length === 0
  const powerLabel =
    model.power?.on === true
      ? t('uiLibrary.deviceCard.turnOff', 'Turn off')
      : t('uiLibrary.deviceCard.turnOn', 'Turn on')
  const artwork = (
    <div className="grid w-full max-w-48 grid-cols-1 gap-2 text-center">
      <MediaArtwork
        kind={model.artwork}
        on={on}
        imageUrl={model.imageUrl}
        caption={model.artCaption}
        className="h-auto w-full max-w-48 aspect-square"
      />
      {model.title === null ? null : (
        <div className="text-sm font-semibold leading-tight" data-testid="dc-media-title">
          {model.title}
        </div>
      )}
      {model.subtitle === null ? null : (
        <div className="text-xs text-foreground-muted">{model.subtitle}</div>
      )}
    </div>
  )
  return (
    <DeviceCard
      kind="media"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      initialView={initialView}
      remoteExtra={playbackExtra(model.playback, !on, actions, t)}
      activity={model.phase}
      state={{ label, since: model.since, tone: TONE[model.phase] }}
      scene={{
        columns: {
          left: volume,
          right:
            model.power === null || powerOnly
              ? []
              : [
                  columnButton('power', {
                    glyph: 'power',
                    label: powerLabel,
                    tone: model.power.on ? 'primary' : 'default',
                    testId: 'dc-media-power',
                    onPress: () => actions.onPower(!(model.power?.on ?? false)),
                  }),
                ],
        },
        image: powerOnly ? (
          <ScenePower on={on} label={powerLabel} testId="dc-media-power" onToggle={actions.onPower}>
            {artwork}
          </ScenePower>
        ) : (
          artwork
        ),
        bottom,
      }}
    />
  )
}
