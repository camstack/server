import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { ApplianceCard } from '../scenes/appliance/ApplianceCard'
import { applianceKindOf, plugAppliancePhase } from './appliance-model'
import { coarseDuration } from './coarse-duration'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'
import { useSwitchPower } from './use-switch-power'

const noop = (): void => undefined

/**
 * A washer, a dryer or a dishwasher known only through what feeds it: whether a
 * cycle runs (`running-state`, from the draw or the device) and the `switch`
 * that powers it. No programs, no start: the card says what it knows and
 * powers the switch, arming before it cuts a running cycle.
 */
export function ConnectedApplianceCard({
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
  const power = useSwitchPower({ deviceId, optimistic, card })
  const running = useDeviceStateSlice(
    dev?.runningState === undefined ? undefined : dev.state.runningState,
  )
  const hasRunning = dev?.runningState !== undefined
  if (!hasRunning && !power.bound) return null
  if (hasRunning && running === undefined) return null
  if (power.bound && power.on === undefined) return null
  const switchOn = power.bound ? power.on : undefined
  const phase = plugAppliancePhase(running?.running, switchOn)
  const runningSince = running?.since ?? null
  return (
    <ApplianceCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        kind: applianceKindOf(card.deviceType),
        phase,
        phaseLabel: phase === 'run' ? (running?.phase ?? null) : null,
        since:
          phase === 'off' || runningSince === null
            ? power.since
            : coarseDuration(Date.now() - runningSince, t),
        power: power.bound && typeof power.on === 'boolean' ? { on: power.on } : null,
        program: null,
        controls: null,
        remainingMinutes: null,
        endsAt: null,
        progress: null,
        startBlocked: null,
        errorLabel: null,
      }}
      actions={{
        ...card.actions,
        onPower: power.onPower,
        onProgram: noop,
        onStart: noop,
        onPause: noop,
        onResume: noop,
        onStop: noop,
      }}
    />
  )
}
