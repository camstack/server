import type { ReactElement } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { ValveIllustration } from '../../illustrations/ValveIllustration'
import { type ColumnItem, columnButton, columnSlider } from '../../shell/column-items'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import { SCENE_DRAWING_CLASS } from '../../shell/scene-layout'
import type { ValveActivity, ValveCardActions, ValveCardModel } from './model'

export interface ValveCardProps {
  readonly model: ValveCardModel
  readonly actions: ValveCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

const TONE: Readonly<Record<ValveActivity, CardTone>> = {
  open: 'info',
  opening: 'info',
  closing: 'info',
  closed: 'muted',
  stopped: 'warning',
}

export function valveStateLabel(model: ValveCardModel, t: UiTextFn): string {
  switch (model.activity) {
    case 'open':
      return model.position !== null && model.position < 100
        ? `${t('uiLibrary.deviceCard.valve.open', 'Open')} ${Math.round(model.position)}%`
        : t('uiLibrary.deviceCard.valve.open', 'Open')
    case 'opening':
      return t('uiLibrary.deviceCard.valve.opening', 'Opening…')
    case 'closing':
      return t('uiLibrary.deviceCard.valve.closing', 'Closing…')
    case 'closed':
      return t('uiLibrary.deviceCard.valve.closed', 'Closed')
    case 'stopped':
      return model.position === null
        ? t('uiLibrary.deviceCard.valve.stopped', 'Stopped')
        : `${t('uiLibrary.deviceCard.valve.stopped', 'Stopped')} · ${Math.round(model.position)}%`
  }
}

/** How far open the drawing is: the position when reported, else the state. */
export function valveOpenness(model: Pick<ValveCardModel, 'activity' | 'position'>): number | null {
  if (model.position !== null) return model.position / 100
  if (model.activity === 'open') return 1
  if (model.activity === 'closed') return 0
  return null
}

function rightColumn(
  model: ValveCardModel,
  actions: ValveCardActions,
  t: UiTextFn,
): readonly ColumnItem[] {
  const moving = model.activity === 'opening' || model.activity === 'closing'
  if (moving && model.canStop) {
    return [
      columnButton('stop', {
        glyph: 'stop',
        tone: 'primary',
        label: t('uiLibrary.deviceCard.valve.stop', 'Stop'),
        testId: 'dc-valve-stop',
        onPress: actions.onStop,
      }),
    ]
  }
  const showOpen = model.canOpen && model.activity !== 'open'
  const showClose = model.canClose && model.activity !== 'closed'
  return [
    ...(showOpen
      ? [
          columnButton('open', {
            glyph: 'water',
            tone: 'primary',
            disabled: moving,
            label: t('uiLibrary.deviceCard.valve.openAction', 'Open'),
            testId: 'dc-valve-open',
            onPress: actions.onOpen,
          }),
        ]
      : []),
    ...(showClose
      ? [
          columnButton('close', {
            glyph: 'stop',
            tone: showOpen ? 'default' : 'primary',
            disabled: moving,
            label: t('uiLibrary.deviceCard.valve.closeAction', 'Close'),
            testId: 'dc-valve-close',
            onPress: actions.onClose,
          }),
        ]
      : []),
  ]
}

/**
 * A water or gas valve: the lever on the pipe says open or closed, the
 * opposite command sits on the right (Stop while it moves), and a valve that
 * takes a position gets the slider on the left.
 */
export function ValveCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: ValveCardProps): ReactElement {
  const t = useUiText()
  const openness = valveOpenness(model)
  return (
    <DeviceCard
      kind="valve"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.activity}
      state={{
        label: valveStateLabel(model, t),
        since: model.since,
        tone: TONE[model.activity],
      }}
      scene={{
        columns: {
          left: model.positionable
            ? [
                columnSlider('position', {
                  value: model.position ?? 0,
                  min: 0,
                  max: 100,
                  step: 5,
                  ariaLabel: t('uiLibrary.deviceCard.valve.position', 'Opening'),
                  testId: 'dc-valve-position',
                  onCommit: actions.onPosition,
                }),
              ]
            : [],
          right: rightColumn(model, actions, t),
        },
        image: (
          <ValveIllustration
            openness={openness}
            flowing={openness !== null && openness > 0}
            className={SCENE_DRAWING_CLASS}
          />
        ),
      }}
    />
  )
}
