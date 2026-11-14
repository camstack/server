import type { ReactElement } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { LockIllustration, type LockLook } from '../../illustrations/LockIllustration'
import { type ColumnItem, columnArmedButton, columnButton } from '../../shell/column-items'
import { type BottomRow, rowText } from '../../shell/bottom-rows'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import { SCENE_DRAWING_CLASS } from '../../shell/scene-layout'
import type { LockActivity, LockCardActions, LockCardModel } from './model'

export interface LockCardProps {
  readonly model: LockCardModel
  readonly actions: LockCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

const TONE: Readonly<Record<LockActivity, CardTone>> = {
  locked: 'success',
  unlocked: 'warning',
  locking: 'info',
  unlocking: 'info',
  jammed: 'danger',
}

const LOOK: Readonly<Record<LockActivity, LockLook>> = {
  locked: 'locked',
  unlocked: 'unlocked',
  locking: 'moving',
  unlocking: 'moving',
  jammed: 'jammed',
}

export function lockStateLabel(activity: LockActivity, doorOpen: boolean, t: UiTextFn): string {
  switch (activity) {
    case 'locked':
      return t('uiLibrary.deviceCard.lock.locked', 'Locked')
    case 'unlocked':
      return doorOpen
        ? t('uiLibrary.deviceCard.lock.unlockedDoorOpen', 'Unlocked · door open')
        : t('uiLibrary.deviceCard.lock.unlocked', 'Unlocked')
    case 'locking':
      return t('uiLibrary.deviceCard.lock.locking', 'Locking…')
    case 'unlocking':
      return t('uiLibrary.deviceCard.lock.unlocking', 'Unlocking…')
    case 'jammed':
      return t('uiLibrary.deviceCard.lock.jammed', 'Jammed')
  }
}

function doorRows(model: LockCardModel, t: UiTextFn): readonly BottomRow[] {
  const door = model.door
  if (door === null) return []
  const state =
    door.reading === 'unknown'
      ? '—'
      : door.reading === 'open'
        ? t('uiLibrary.deviceCard.lock.doorOpen', 'Open')
        : t('uiLibrary.deviceCard.lock.doorClosed', 'Closed')
  return [
    rowText('door', {
      text: `${door.name} · ${state}`,
      tone: door.reading === 'open' ? 'warning' : 'muted',
      testId: 'dc-lock-door',
    }),
  ]
}

function unlockButton(
  model: LockCardModel,
  actions: LockCardActions,
  t: UiTextFn,
): readonly ColumnItem[] {
  if (!model.canUnlock) return []
  return [
    columnArmedButton('unlock', {
      testId: 'dc-lock-unlock',
      glyph: 'lockOpen',
      tone: 'primary',
      label: t('uiLibrary.deviceCard.lock.unlock', 'Unlock'),
      onConfirm: actions.onUnlock,
    }),
  ]
}

/** Latch release, two presses. Offered in every state except jammed. */
function openButton(
  model: LockCardModel,
  actions: LockCardActions,
  t: UiTextFn,
): readonly ColumnItem[] {
  if (!model.canOpen || model.activity === 'jammed') return []
  return [
    columnArmedButton('open', {
      testId: 'dc-lock-open',
      glyph: 'doorOpen',
      label: t('uiLibrary.deviceCard.lock.open', 'Open door'),
      onConfirm: actions.onOpen,
    }),
  ]
}

function lockButton(
  model: LockCardModel,
  actions: LockCardActions,
  label: string,
): readonly ColumnItem[] {
  if (!model.canLock) return []
  return [
    columnButton('lock', {
      glyph: 'lock',
      tone: 'primary',
      disabled: model.doorOpen,
      label,
      testId: 'dc-lock-lock',
      onPress: actions.onLock,
    }),
  ]
}

function rightColumn(
  model: LockCardModel,
  actions: LockCardActions,
  t: UiTextFn,
): readonly ColumnItem[] {
  const lockWord = t('uiLibrary.deviceCard.lock.lock', 'Lock')
  const open = openButton(model, actions, t)
  switch (model.activity) {
    case 'locked':
      return [...unlockButton(model, actions, t), ...open]
    case 'unlocked':
      return [...lockButton(model, actions, lockWord), ...open]
    case 'locking':
    case 'unlocking':
      return [
        columnButton('moving', {
          glyph: 'lock',
          disabled: true,
          label: lockWord,
          testId: 'dc-lock-moving',
          onPress: () => undefined,
        }),
        ...open,
      ]
    case 'jammed':
      return [
        ...lockButton(model, actions, t('uiLibrary.deviceCard.lock.retry', 'Retry')),
        ...unlockButton(model, actions, t),
      ]
  }
}

/**
 * A lock: the linked door on the left, the padlock in the middle, the one
 * command that changes it on the right. Unlock and Open door are armed (a
 * second press confirms). Open door is offered in every state except jammed,
 * unlocked included, when the device declares it. Lock waits for a closed
 * door. A jammed lock turns the scene red and offers Retry beside Unlock.
 */
export function LockCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: LockCardProps): ReactElement {
  const t = useUiText()
  const waiting = model.activity === 'unlocked' && model.doorOpen && model.canLock
  return (
    <DeviceCard
      kind="lock"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.activity}
      state={{
        label: lockStateLabel(model.activity, model.doorOpen, t),
        since: model.since,
        tone: TONE[model.activity],
      }}
      scene={{
        alert: model.activity === 'jammed',
        columns: { right: rightColumn(model, actions, t) },
        image: <LockIllustration look={LOOK[model.activity]} className={SCENE_DRAWING_CLASS} />,
        bottom: [
          ...doorRows(model, t),
          ...(waiting
            ? [
                rowText('wait', {
                  text: t('uiLibrary.deviceCard.lock.closeDoorFirst', 'Close the door first'),
                  tone: 'warning',
                  testId: 'dc-lock-wait',
                }),
              ]
            : []),
        ],
      }}
    />
  )
}
