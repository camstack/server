import type { ReactElement, ReactNode } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { MediaArtwork } from '../../illustrations/MediaArtwork'
import { CardButton } from '../../parts/CardButton'
import { MenuButton } from '../../parts/MenuButton'
import { HorizontalSlider } from '../../parts/sliders'
import { StepColumn } from '../../parts/StepColumn'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import {
  formatTrackTime,
  type MediaCardActions,
  type MediaCardModel,
  type MediaPhase,
} from './model'

export interface MediaPlayerCardProps {
  readonly model: MediaCardModel
  readonly actions: MediaCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
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

function volumeColumn(model: MediaCardModel, actions: MediaCardActions, t: UiTextFn): ReactNode {
  const v = model.volume
  if (v === null) return null
  const off = model.phase === 'off'
  return (
    <>
      <StepColumn
        testId="dc-media-volume"
        value={v.muted ? t('uiLibrary.deviceCard.media.muted', 'muted') : v.level}
        notes={v.muted || v.level === null ? [] : [t('uiLibrary.deviceCard.media.vol', 'vol')]}
        up={{
          glyph: 'plus',
          label: t('uiLibrary.deviceCard.media.volumeUp', 'Volume up'),
          disabled: off,
          onPress: actions.onVolumeUp,
        }}
        down={{
          glyph: 'minus',
          label: t('uiLibrary.deviceCard.media.volumeDown', 'Volume down'),
          disabled: off,
          onPress: actions.onVolumeDown,
        }}
      />
      {v.mutable ? (
        <CardButton
          glyph="mute"
          tone={v.muted ? 'on' : 'default'}
          aria-pressed={v.muted}
          aria-label={t('uiLibrary.deviceCard.media.mute', 'Mute')}
          title={t('uiLibrary.deviceCard.media.mute', 'Mute')}
          disabled={off}
          data-testid="dc-media-mute"
          onClick={() => actions.onMute(!v.muted)}
        />
      ) : null}
    </>
  )
}

function transportRow(model: MediaCardModel, actions: MediaCardActions, t: UiTextFn): ReactNode {
  const tr = model.transport
  if (tr === null) return null
  const off = model.phase === 'off'
  const play = t('uiLibrary.deviceCard.media.play', 'Play')
  const pause = t('uiLibrary.deviceCard.pause', 'Pause')
  if (tr.blind) {
    return (
      <div className="flex justify-center gap-2" data-testid="dc-media-transport">
        <CardButton
          glyph="play"
          aria-label={play}
          title={play}
          disabled={off}
          onClick={actions.onPlay}
        />
        <CardButton
          glyph="pause"
          aria-label={pause}
          title={pause}
          disabled={off}
          onClick={actions.onPause}
        />
        {tr.stop ? (
          <CardButton
            glyph="stop"
            aria-label={t('uiLibrary.deviceCard.stop', 'Stop')}
            title={t('uiLibrary.deviceCard.stop', 'Stop')}
            disabled={off}
            onClick={actions.onStop}
          />
        ) : null}
      </div>
    )
  }
  const playing = model.phase === 'playing'
  return (
    <div className="flex justify-center gap-2" data-testid="dc-media-transport">
      {tr.previous ? (
        <CardButton
          glyph="previous"
          aria-label={t('uiLibrary.deviceCard.media.previous', 'Previous')}
          disabled={off}
          onClick={actions.onPrevious}
        />
      ) : null}
      <CardButton
        glyph={playing ? 'pause' : 'play'}
        tone="primary"
        aria-label={playing ? pause : play}
        title={playing ? pause : play}
        disabled={off}
        data-testid="dc-media-play"
        onClick={playing ? actions.onPause : actions.onPlay}
      />
      {tr.next ? (
        <CardButton
          glyph="next"
          aria-label={t('uiLibrary.deviceCard.media.next', 'Next')}
          disabled={off}
          onClick={actions.onNext}
        />
      ) : null}
    </div>
  )
}

function bottomZone(model: MediaCardModel, actions: MediaCardActions, t: UiTextFn): ReactNode {
  const seek = model.seek
  const transport = transportRow(model, actions, t)
  if (seek === null && transport === null) return null
  return (
    <>
      {seek === null ? null : (
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
      )}
      {transport}
    </>
  )
}

/**
 * A media player: the volume on the left, what is playing in the middle (its
 * cover, a TV's input, or nothing when the content is not known), power and
 * the source on the right, the track position and the transport below. A
 * player that cannot report its playback gets blind play / pause / stop keys.
 */
export function MediaPlayerCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: MediaPlayerCardProps): ReactElement {
  const t = useUiText()
  const on = model.phase !== 'off'
  const label = mediaPhaseLabel(model.phase, t)
  const sourceLabel = t('uiLibrary.deviceCard.media.source', 'Source')
  const hasRight = model.power !== null || model.sources.length > 0
  return (
    <DeviceCard
      kind="media"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.phase}
      state={{ label, since: model.since, tone: TONE[model.phase] }}
      scene={{
        left: volumeColumn(model, actions, t),
        image: (
          <div className="grid max-w-40 justify-items-center gap-2 text-center">
            <MediaArtwork
              kind={model.artwork}
              on={on}
              imageUrl={model.imageUrl}
              caption={model.artCaption}
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
        ),
        right: hasRight ? (
          <>
            {model.power === null ? null : (
              <CardButton
                glyph="power"
                tone={model.power.on ? 'primary' : 'default'}
                data-testid="dc-media-power"
                onClick={() => actions.onPower(!(model.power?.on ?? false))}
              >
                {model.power.on
                  ? t('uiLibrary.deviceCard.turnOff', 'Turn off')
                  : t('uiLibrary.deviceCard.turnOn', 'Turn on')}
              </CardButton>
            )}
            {model.sources.length === 0 ? null : (
              <MenuButton
                options={model.sources.map((s) => ({ id: s, label: s }))}
                value={model.source}
                onChange={actions.onSource}
                ariaLabel={sourceLabel}
                triggerLabel={sourceLabel}
                disabled={!on}
                testId="dc-media-source"
              />
            )}
          </>
        ) : null,
        bottom: bottomZone(model, actions, t),
      }}
    />
  )
}
