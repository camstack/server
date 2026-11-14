import { type ReactElement, useState } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import type { RobotActivity } from '../../illustrations/RobotIllustration'
import { RobotIllustration } from '../../illustrations/RobotIllustration'
import { CardButton } from '../../parts/CardButton'
import { CardIcon } from '../../parts/CardIcon'
import {
  type ColumnItem,
  columnArmedButton,
  columnButton,
  columnStep,
  columnValue,
} from '../../shell/column-items'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import { SCENE_DRAWING_CLASS } from '../../shell/scene-layout'
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

function leftColumn(
  model: RobotCardModel,
  actions: RobotCardActions,
  t: UiTextFn,
): readonly ColumnItem[] {
  if (model.mower) {
    if (model.progress === null) return []
    return [
      columnValue('progress', {
        value: `${Math.round(model.progress)}%`,
        caption: t('uiLibrary.deviceCard.robot.completed', 'completed'),
        testId: 'dc-robot-progress',
      }),
    ]
  }
  const suction = model.suction
  if (suction === null || suction.options.length === 0) return []
  const index = suction.options.indexOf(suction.value ?? '')
  const step = (delta: number) => (): void => {
    const next = suction.options[Math.min(suction.options.length - 1, Math.max(0, index + delta))]
    if (next !== undefined && next !== suction.value) actions.onSuction(next)
  }
  return columnStep('suction', {
    testId: 'dc-robot-suction',
    value: suction.value,
    caption: t('uiLibrary.deviceCard.robot.suction', 'suction'),
    up: {
      glyph: 'up',
      label: t('uiLibrary.deviceCard.robot.moreSuction', 'More suction'),
      disabled: index >= suction.options.length - 1,
      onPress: step(1),
    },
    down: {
      glyph: 'down',
      label: t('uiLibrary.deviceCard.robot.lessSuction', 'Less suction'),
      disabled: index <= 0,
      onPress: step(-1),
    },
  })
}

function rightColumn(
  model: RobotCardModel,
  actions: RobotCardActions,
  t: UiTextFn,
): readonly ColumnItem[] {
  const c = model.controls
  const going = model.activity === 'clean' || model.activity === 'ret'
  const atBase =
    model.activity === 'sleep' || model.activity === 'charge' || model.activity === 'ret'
  return [
    ...(going && c.pause
      ? [
          columnButton('go', {
            glyph: 'pause',
            tone: 'primary',
            label: t('uiLibrary.deviceCard.pause', 'Pause'),
            testId: 'dc-robot-go',
            onPress: actions.onPause,
          }),
        ]
      : !going && c.start
        ? [
            columnButton('go', {
              glyph: 'play',
              tone: 'primary',
              label: model.mower
                ? t('uiLibrary.deviceCard.robot.mow', 'Mow')
                : t('uiLibrary.deviceCard.robot.clean', 'Clean'),
              testId: 'dc-robot-go',
              onPress: actions.onStart,
            }),
          ]
        : []),
    ...(c.stop && (model.activity === 'clean' || model.activity === 'pause')
      ? [
          columnArmedButton('stop', {
            glyph: 'stop',
            label: t('uiLibrary.deviceCard.stop', 'Stop'),
            testId: 'dc-robot-stop',
            onConfirm: actions.onStop,
          }),
        ]
      : []),
    ...(c.dock
      ? [
          columnButton('dock', {
            glyph: 'home',
            disabled: atBase,
            label: t('uiLibrary.deviceCard.robot.base', 'Base'),
            testId: 'dc-robot-dock',
            onPress: actions.onDock,
          }),
        ]
      : []),
    ...(!model.mower && c.locate
      ? [
          columnButton('locate', {
            glyph: 'locate',
            label: t('uiLibrary.deviceCard.robot.locate', 'Find'),
            testId: 'dc-robot-locate',
            onPress: actions.onLocate,
          }),
        ]
      : []),
  ]
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
  const robotError =
    model.activity === 'err' && !model.mower && model.errorLabel !== null ? (
      <div
        className="flex items-start justify-center gap-1 text-center text-xs font-semibold text-danger"
        data-testid="dc-robot-error"
      >
        <CardIcon glyph="warning" />
        {model.errorLabel}
      </div>
    ) : null
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
        columns: {
          left: leftColumn(model, actions, t),
          right: rightColumn(model, actions, t),
        },
        image: mapShown ? (
          <img
            src={model.mapUrl ?? undefined}
            alt={t('uiLibrary.deviceCard.robot.mapAlt', 'Cleaning map')}
            data-testid="dc-robot-map"
            className="h-auto w-full max-w-52 rounded-xl"
          />
        ) : (
          <RobotIllustration
            mower={model.mower}
            activity={model.activity}
            progress={model.progress}
            className={SCENE_DRAWING_CLASS}
          />
        ),
        bottom:
          robotError === null && model.mapUrl === null ? null : (
            <>
              {robotError}
              {model.mapUrl === null ? null : (
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
              )}
            </>
          ),
      }}
    />
  )
}
