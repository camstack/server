import { type ReactElement, type ReactNode, useState } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import type { RobotActivity } from '../../illustrations/RobotIllustration'
import { RobotIllustration } from '../../illustrations/RobotIllustration'
import { CardButton } from '../../parts/CardButton'
import { CardIcon } from '../../parts/CardIcon'
import { StepColumn } from '../../parts/StepColumn'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import type { RobotCardActions, RobotCardModel } from './model'

export interface RobotCardProps {
  readonly model: RobotCardModel
  readonly actions: RobotCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

const TONE: Readonly<Record<RobotActivity, CardTone>> = {
  clean: 'primary',
  ret: 'primary',
  pause: 'warning',
  charge: 'success',
  sleep: 'muted',
  idle: 'muted',
  err: 'danger',
}

export function robotStateLabel(model: RobotCardModel, t: UiTextFn): string {
  switch (model.activity) {
    case 'clean':
      return model.mower
        ? t('uiLibrary.deviceCard.robot.mowing', 'Mowing')
        : t('uiLibrary.deviceCard.robot.cleaning', 'Cleaning')
    case 'pause':
      return t('uiLibrary.deviceCard.robot.paused', 'Paused')
    case 'ret':
      return t('uiLibrary.deviceCard.robot.returning', 'Returning to base')
    case 'charge':
      return t('uiLibrary.deviceCard.robot.charging', 'Charging')
    case 'sleep':
      return t('uiLibrary.deviceCard.robot.docked', 'Docked')
    case 'idle':
      return t('uiLibrary.deviceCard.robot.idle', 'Idle')
    case 'err':
      return model.mower && model.errorLabel !== null
        ? model.errorLabel
        : t('uiLibrary.deviceCard.robot.stuck', 'Stuck')
  }
}

function leftColumn(model: RobotCardModel, actions: RobotCardActions, t: UiTextFn): ReactNode {
  if (model.mower) {
    if (model.progress === null) return null
    return (
      <StepColumn
        testId="dc-robot-progress"
        value={<span className="text-primary">{`${Math.round(model.progress)}%`}</span>}
        notes={[t('uiLibrary.deviceCard.robot.completed', 'completed')]}
        up={{ glyph: 'up', label: '' }}
        down={{ glyph: 'down', label: '' }}
      />
    )
  }
  const suction = model.suction
  if (suction === null || suction.options.length === 0) return null
  const index = suction.options.indexOf(suction.value ?? '')
  const step = (delta: number) => (): void => {
    const next = suction.options[Math.min(suction.options.length - 1, Math.max(0, index + delta))]
    if (next !== undefined && next !== suction.value) actions.onSuction(next)
  }
  return (
    <StepColumn
      testId="dc-robot-suction"
      value={suction.value}
      notes={[t('uiLibrary.deviceCard.robot.suction', 'suction')]}
      up={{
        glyph: 'up',
        label: t('uiLibrary.deviceCard.robot.moreSuction', 'More suction'),
        disabled: index >= suction.options.length - 1,
        onPress: step(1),
      }}
      down={{
        glyph: 'down',
        label: t('uiLibrary.deviceCard.robot.lessSuction', 'Less suction'),
        disabled: index <= 0,
        onPress: step(-1),
      }}
    />
  )
}

function rightColumn(model: RobotCardModel, actions: RobotCardActions, t: UiTextFn): ReactNode {
  const c = model.controls
  const going = model.activity === 'clean' || model.activity === 'ret'
  const atBase =
    model.activity === 'sleep' || model.activity === 'charge' || model.activity === 'ret'
  return (
    <>
      {going && c.pause ? (
        <CardButton
          glyph="pause"
          tone="primary"
          data-testid="dc-robot-go"
          onClick={actions.onPause}
        >
          {t('uiLibrary.deviceCard.pause', 'Pause')}
        </CardButton>
      ) : !going && c.start ? (
        <CardButton glyph="play" tone="primary" data-testid="dc-robot-go" onClick={actions.onStart}>
          {model.mower
            ? t('uiLibrary.deviceCard.robot.mow', 'Mow')
            : t('uiLibrary.deviceCard.robot.clean', 'Clean')}
        </CardButton>
      ) : null}
      {c.dock ? (
        <CardButton
          glyph="home"
          disabled={atBase}
          data-testid="dc-robot-dock"
          onClick={actions.onDock}
        >
          {t('uiLibrary.deviceCard.robot.base', 'Base')}
        </CardButton>
      ) : null}
      {!model.mower && c.locate ? (
        <CardButton glyph="locate" data-testid="dc-robot-locate" onClick={actions.onLocate}>
          {t('uiLibrary.deviceCard.robot.locate', 'Find')}
        </CardButton>
      ) : null}
    </>
  )
}

/**
 * A robot vacuum or a robot mower, drawn on its floor: suction (a vacuum) or
 * how much of the lawn is cut (a mower) on the left, start / pause, back to
 * base and find on the right, the map toggle below when the device has one.
 * An error stops the drawing where it got stuck and names the cause.
 */
export function RobotCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: RobotCardProps): ReactElement {
  const t = useUiText()
  const [showMap, setShowMap] = useState(false)
  const label = robotStateLabel(model, t)
  const mapShown = showMap && model.mapUrl !== null
  const c = model.controls
  const hasRight = c.start || c.pause || c.dock || (!model.mower && c.locate)
  return (
    <DeviceCard
      kind={model.mower ? 'mower' : 'vacuum'}
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.activity}
      state={{ label, since: model.since, tone: TONE[model.activity] }}
      scene={{
        left: leftColumn(model, actions, t),
        image: (
          <div className="grid justify-items-center gap-1.5">
            {mapShown ? (
              <img
                src={model.mapUrl ?? undefined}
                alt={t('uiLibrary.deviceCard.robot.mapAlt', 'Cleaning map')}
                data-testid="dc-robot-map"
                className="h-auto w-42.5 rounded-xl"
              />
            ) : (
              <RobotIllustration
                mower={model.mower}
                activity={model.activity}
                progress={model.progress}
              />
            )}
            {model.activity === 'err' && !model.mower && model.errorLabel !== null ? (
              <div
                className="flex max-w-32 items-start justify-center gap-1 text-center text-xs font-semibold text-danger"
                data-testid="dc-robot-error"
              >
                <CardIcon glyph="warning" />
                {model.errorLabel}
              </div>
            ) : null}
          </div>
        ),
        right: hasRight ? rightColumn(model, actions, t) : null,
        bottom:
          model.mapUrl === null ? null : (
            <CardButton
              glyph={mapShown ? 'robot' : 'map'}
              tone={mapShown ? 'on' : 'default'}
              actuates={false}
              aria-pressed={mapShown}
              data-testid="dc-robot-map-toggle"
              onClick={() => setShowMap((v) => !v)}
            >
              {mapShown
                ? model.mower
                  ? t('uiLibrary.deviceCard.robot.mower', 'Mower')
                  : t('uiLibrary.deviceCard.robot.robot', 'Robot')
                : t('uiLibrary.deviceCard.robot.map', 'Map')}
            </CardButton>
          ),
      }}
    />
  )
}
