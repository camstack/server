import { type ReactElement, type ReactNode, useState } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { AlarmIllustration, type AlarmLook } from '../../illustrations/AlarmIllustration'
import { ButtonGroup } from '../../parts/ButtonGroup'
import { CardButton } from '../../parts/CardButton'
import { CodePad } from '../../parts/CodePad'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import { SCENE_DRAWING_CLASS } from '../../shell/scene-layout'
import type { AlarmActivity, AlarmArmMode, AlarmCardActions, AlarmCardModel } from './model'

export interface AlarmCardProps {
  readonly model: AlarmCardModel
  readonly actions: AlarmCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/** The mode row's id for Disarmed (never a cap arm mode). */
export const ALARM_DISARMED = 'disarmed'

type Pending = { readonly kind: 'disarm' } | { readonly kind: 'arm'; readonly mode: AlarmArmMode }

const TONE: Readonly<Record<AlarmActivity, CardTone>> = {
  disarmed: 'muted',
  armed: 'success',
  arming: 'warning',
  disarming: 'info',
  pending: 'warning',
  triggered: 'danger',
}

const LOOK: Readonly<Record<AlarmActivity, AlarmLook>> = {
  disarmed: 'disarmed',
  armed: 'armed',
  arming: 'arming',
  disarming: 'arming',
  pending: 'arming',
  triggered: 'triggered',
}

export function alarmModeLabel(mode: AlarmArmMode, t: UiTextFn): string {
  switch (mode) {
    case 'home':
      return t('uiLibrary.deviceCard.alarm.home', 'Home')
    case 'away':
      return t('uiLibrary.deviceCard.alarm.away', 'Away')
    case 'night':
      return t('uiLibrary.deviceCard.alarm.night', 'Night')
    case 'vacation':
      return t('uiLibrary.deviceCard.alarm.vacation', 'Vacation')
    case 'custom_bypass':
      return t('uiLibrary.deviceCard.alarm.custom', 'Custom')
  }
}

export function alarmStateLabel(model: AlarmCardModel, t: UiTextFn): string {
  const mode = model.mode === null ? null : alarmModeLabel(model.mode, t)
  switch (model.activity) {
    case 'disarmed':
      return t('uiLibrary.deviceCard.alarm.disarmed', 'Disarmed')
    case 'armed':
      return mode === null
        ? t('uiLibrary.deviceCard.alarm.armed', 'Armed')
        : `${t('uiLibrary.deviceCard.alarm.armed', 'Armed')} · ${mode}`
    case 'arming':
      return t('uiLibrary.deviceCard.alarm.arming', 'Arming…')
    case 'disarming':
      return t('uiLibrary.deviceCard.alarm.disarming', 'Disarming…')
    case 'pending':
      return t('uiLibrary.deviceCard.alarm.pending', 'Entry delay')
    case 'triggered':
      return t('uiLibrary.deviceCard.alarm.triggered', 'Alarm!')
  }
}

/** The lit chip of the mode row: Disarmed, or the mode it is armed (or arming) in. */
function selectedMode(model: AlarmCardModel): string | null {
  return model.activity === 'disarmed' ? ALARM_DISARMED : model.mode
}

function confirmRow(
  pending: Pending,
  model: AlarmCardModel,
  run: (code: string | null) => void,
  cancel: () => void,
  t: UiTextFn,
): ReactNode {
  const label =
    pending.kind === 'disarm'
      ? t('uiLibrary.deviceCard.alarm.disarm', 'Disarm')
      : `${t('uiLibrary.deviceCard.alarm.arm', 'Arm')} · ${alarmModeLabel(pending.mode, t)}`
  if (model.requiresCode) {
    return <CodePad testId="dc-alarm-code" submitLabel={label} onSubmit={run} onCancel={cancel} />
  }
  return (
    <span className="inline-flex items-center gap-2">
      <CardButton tone="danger" data-testid="dc-alarm-confirm" onClick={() => run(null)}>
        {label}
      </CardButton>
      <CardButton glyph="cancel" data-testid="dc-alarm-cancel" onClick={cancel}>
        {t('uiLibrary.deviceCard.cancel', 'Cancel')}
      </CardButton>
    </span>
  )
}

/**
 * An alarm panel: the shield says the state, and its only control is the row
 * of the modes it declares (Disarmed first). Disarming always asks to confirm;
 * a panel that wants a code asks for it on the pad, for arming too. Going off
 * turns the scene red.
 */
export function AlarmCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: AlarmCardProps): ReactElement {
  const t = useUiText()
  const [pending, setPending] = useState<Pending | null>(null)
  const options = [
    ...(model.canDisarm
      ? [
          {
            id: ALARM_DISARMED,
            label: t('uiLibrary.deviceCard.alarm.disarmed', 'Disarmed'),
          },
        ]
      : []),
    ...(model.canArm
      ? model.modes.map((mode) => ({
          id: mode,
          label: alarmModeLabel(mode, t),
        }))
      : []),
  ]
  const choose = (id: string): void => {
    if (id === selectedMode(model)) return
    if (id === ALARM_DISARMED) {
      setPending({ kind: 'disarm' })
      return
    }
    const mode = model.modes.find((m) => m === id)
    if (mode === undefined) return
    if (model.requiresCode) setPending({ kind: 'arm', mode })
    else actions.onArm(mode, null)
  }
  const run = (code: string | null): void => {
    if (pending === null) return
    setPending(null)
    if (pending.kind === 'disarm') actions.onDisarm(code)
    else actions.onArm(pending.mode, code)
  }
  const moving = model.activity === 'arming' || model.activity === 'disarming'
  return (
    <DeviceCard
      kind="alarm"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.activity}
      state={{
        label: alarmStateLabel(model, t),
        since: model.since,
        tone: TONE[model.activity],
      }}
      scene={{
        alert: model.activity === 'triggered',
        image: <AlarmIllustration look={LOOK[model.activity]} className={SCENE_DRAWING_CLASS} />,
        columns: {},
        bottom:
          options.length === 0 ? null : pending !== null ? (
            confirmRow(pending, model, run, () => setPending(null), t)
          ) : (
            <ButtonGroup
              testId="dc-alarm-modes"
              ariaLabel={t('uiLibrary.deviceCard.alarm.modes', 'Alarm mode')}
              options={options}
              value={selectedMode(model)}
              disabled={moving}
              onChange={choose}
            />
          ),
      }}
    />
  )
}
