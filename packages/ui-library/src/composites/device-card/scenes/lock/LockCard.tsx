import type { ReactElement, ReactNode } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { LockIllustration, type LockLook } from '../../illustrations/LockIllustration'
import { ArmedButton } from '../../parts/ArmedButton'
import { CardButton } from '../../parts/CardButton'
import { InfoTile } from '../../parts/InfoTile'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
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

function doorTile(model: LockCardModel, t: UiTextFn): ReactNode {
  const door = model.door
  if (door === null) return null
  const open = door.reading === 'open'
  return (
    <InfoTile
      testId="dc-lock-door"
      glyph={open ? 'doorOpen' : 'door'}
      tone={open ? 'warning' : 'default'}
      label={door.name}
      value={
        door.reading === 'unknown'
          ? null
          : open
            ? t('uiLibrary.deviceCard.lock.doorOpen', 'Open')
            : t('uiLibrary.deviceCard.lock.doorClosed', 'Closed')
      }
    />
  )
}

function unlockButton(model: LockCardModel, actions: LockCardActions, t: UiTextFn): ReactNode {
  if (!model.canUnlock) return null
  return (
    <ArmedButton
      testId="dc-lock-unlock"
      glyph="lockOpen"
      tone="primary"
      onConfirm={actions.onUnlock}
    >
      {t('uiLibrary.deviceCard.lock.unlock', 'Unlock')}
    </ArmedButton>
  )
}

/** Latch release, two presses. Offered in every state except jammed. */
function openButton(model: LockCardModel, actions: LockCardActions, t: UiTextFn): ReactNode {
  if (!model.canOpen || model.activity === 'jammed') return null
  return (
    <ArmedButton testId="dc-lock-open" glyph="doorOpen" onConfirm={actions.onOpen}>
      {t('uiLibrary.deviceCard.lock.open', 'Open door')}
    </ArmedButton>
  )
}

function lockButton(
  model: LockCardModel,
  actions: LockCardActions,
  t: UiTextFn,
  label: string,
): ReactNode {
  if (!model.canLock) return null
  return (
    <CardButton
      glyph="lock"
      tone="primary"
      disabled={model.doorOpen}
      title={
        model.doorOpen
          ? t('uiLibrary.deviceCard.lock.closeDoorFirst', 'Close the door first')
          : undefined
      }
      data-testid="dc-lock-lock"
      onClick={actions.onLock}
    >
      {label}
    </CardButton>
  )
}

function rightColumn(model: LockCardModel, actions: LockCardActions, t: UiTextFn): ReactNode {
  const lockWord = t('uiLibrary.deviceCard.lock.lock', 'Lock')
  const open = openButton(model, actions, t)
  switch (model.activity) {
    case 'locked':
      return (
        <>
          {unlockButton(model, actions, t)}
          {open}
        </>
      )
    case 'unlocked':
      return (
        <>
          {lockButton(model, actions, t, lockWord)}
          {open}
        </>
      )
    case 'locking':
    case 'unlocking':
      return (
        <>
          <CardButton glyph="lock" disabled data-testid="dc-lock-moving">
            {lockWord}
          </CardButton>
          {open}
        </>
      )
    case 'jammed':
      return (
        <>
          {lockButton(model, actions, t, t('uiLibrary.deviceCard.lock.retry', 'Retry'))}
          {unlockButton(model, actions, t)}
        </>
      )
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
        left: doorTile(model, t),
        image: <LockIllustration look={LOOK[model.activity]} className="h-auto w-24" />,
        right: rightColumn(model, actions, t),
        bottom: waiting ? (
          <p data-testid="dc-lock-wait" className="text-xs text-warning">
            {t('uiLibrary.deviceCard.lock.closeDoorFirst', 'Close the door first')}
          </p>
        ) : null,
      }}
    />
  )
}
