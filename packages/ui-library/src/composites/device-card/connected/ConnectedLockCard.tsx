import { DeviceFeature, type LockControlStatus } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useLockDoorSensor } from '../../../hooks/use-lock-door-sensor'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import { LockCard } from '../scenes/lock/LockCard'
import { coarseDuration } from './coarse-duration'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { lockDoorOpen, lockReadingOf } from './lock-model'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

/**
 * A lock (`lock-control`): lock, unlock and — when the device declares
 * `lock-open` — release the latch; the door is the contact a Customize link
 * names (D984), read from that sensor, never guessed from the lock.
 */
export function ConnectedLockCard({
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
  const door = useLockDoorSensor(client, deviceId)
  const slice = useDeviceStateSlice(
    dev?.lockControl === undefined ? undefined : dev.state.lockControl,
  )
  const { display, applyOptimisticAction } = useOptimisticSlice<LockControlStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.lockControl
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(applyOptimisticAction, {
    fail: card.fail,
    succeed: card.succeed,
  })
  const has = (method: string): boolean => card.implements('lock-control', method)
  const reading = lockReadingOf(display)
  return (
    <LockCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        activity: reading.activity,
        since:
          display.lastChangedAt > 0 ? coarseDuration(Date.now() - display.lastChangedAt, t) : null,
        door,
        doorOpen: lockDoorOpen(door, reading.selfDoorOpen),
        canLock: has('lock'),
        canUnlock: has('unlock'),
        canOpen: has('open') && card.features.includes(DeviceFeature.LockOpen),
      }}
      actions={{
        ...card.actions,
        onLock: () => send({ state: 'locking' }, () => cap.lock({})),
        onUnlock: () => send({ state: 'unlocking' }, () => cap.unlock({})),
        onOpen: () => {
          const open = cap.open
          if (open !== undefined) send({}, () => open({}))
        },
      }}
    />
  )
}
