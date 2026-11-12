import type { DishwasherStatus } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import { ApplianceCard } from '../scenes/appliance/ApplianceCard'
import {
  cycleEndsAt,
  dishwasherPhase,
  dishwasherPrograms,
  dishwasherStartBlocked,
} from './appliance-model'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

/**
 * A dishwasher that speaks for itself (the `dishwasher` cap): its programs,
 * the time left, power, start / pause / resume / stop — each drawn only when
 * the binding implements it, the start refused, with the machine's reason,
 * while the door is open or remote start is off. Its options and reminders are
 * not on the card: the device page shows them (`DishwasherOptionsPanel`).
 */
export function ConnectedDishwasherCard({
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
    dev?.dishwasher === undefined ? undefined : dev.state.dishwasher,
  )
  const { display, applyOptimisticAction } = useOptimisticSlice<DishwasherStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.dishwasher
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(applyOptimisticAction, { fail: card.fail, succeed: card.succeed })
  const phase = dishwasherPhase(display)
  const remaining = display.remaining
  const cycle = phase === 'run' || phase === 'pause'
  const has = (method: string): boolean => card.implements('dishwasher', method)
  return (
    <ApplianceCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        kind: 'dish',
        phase,
        phaseLabel: null,
        since: null,
        power: display.powerOn === null || !has('setPower') ? null : { on: display.powerOn },
        program: dishwasherPrograms(display, true),
        controls: {
          start: has('start'),
          pause: has('pause'),
          resume: has('resume'),
          stop: has('stop'),
        },
        remainingMinutes: cycle && remaining !== null ? remaining / 60 : null,
        endsAt: phase === 'run' && remaining !== null ? cycleEndsAt(remaining) : null,
        progress: display.progress,
        startBlocked: dishwasherStartBlocked(display, t),
        errorLabel: display.errorLabel,
      }}
      actions={{
        ...card.actions,
        onPower: (on) => send({ powerOn: on }, () => cap.setPower({ on })),
        onProgram: (program) =>
          send({ selectedProgram: program }, () => cap.setProgram({ program })),
        onStart: () => send({ state: 'running' }, () => cap.start({})),
        onPause: () => send({ state: 'paused' }, () => cap.pause({})),
        onResume: () => send({ state: 'running' }, () => cap.resume({})),
        onStop: () => send({ state: 'idle' }, () => cap.stop({})),
      }}
    />
  )
}
