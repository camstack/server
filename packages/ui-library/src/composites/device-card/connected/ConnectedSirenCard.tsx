import { useQuery } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useDeviceCommand } from '../../../hooks/use-device-command'
import { useOneShotCommand } from '../../../hooks/use-one-shot-command'
import { Skeleton } from '../../../primitives/skeleton'
import {
  sirenActivityOf,
  sirenAdjustableOf,
  sirenRunOf,
  sirenTriggerInputOf,
} from '../scenes/siren/model'
import { SirenCard } from '../scenes/siren/SirenCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'
import { useSwitchPower } from './use-switch-power'

/** The siren's options are the camera's own; they change rarely. */
const OPTIONS_STALE_MS = 5 * 60_000

/**
 * A siren (a `siren` device, or a switch in the siren role). With the `siren`
 * cap: Sound is `siren.trigger` (seconds or plays, as the siren declares),
 * Stop is `siren.stop`, and the ring counts the served `activeUntil` down.
 * Without it: Sound and Stop are the `switch`, and sounding is open-ended.
 * "Sound on motion" is the device's `motion-trigger`, when it binds one.
 * Every command is one-shot and the card shows only the served slices (D1061).
 */
export function ConnectedSirenCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const power = useSwitchPower({ deviceId, card })
  const siren = dev?.siren
  const motion = dev?.motionTrigger
  const sirenSlice = useDeviceStateSlice(siren === undefined ? undefined : dev?.state.siren)
  const motionSlice = useDeviceStateSlice(
    motion === undefined ? undefined : dev?.state.motionTrigger,
  )
  const runCommand = useDeviceCommand()
  // Sound and Stop share one claim: a double tap must not send twice (D1061).
  const shot = useOneShotCommand()
  const motionShot = useOneShotCommand()
  const has = (method: string): boolean => card.implements('siren', method)
  const readsOptions = siren !== undefined && has('getOptions')
  const options = useQuery({
    queryKey: ['device-card', 'siren-options', deviceId],
    queryFn: () => {
      if (siren === undefined) throw new Error('siren cap not bound')
      return siren.getOptions({})
    },
    enabled: readsOptions,
    staleTime: OPTIONS_STALE_MS,
  })
  if (siren === undefined && !power.bound) return null
  // An unanswered siren is not silent: the card stays pending until a slice answers.
  const pending = siren === undefined ? power.on === undefined : sirenSlice === undefined
  if (pending) return <Skeleton className="h-72 w-full" data-testid="dc-card-pending" />

  const activity = sirenActivityOf(sirenSlice?.active, power.on)
  const send = reportedCommand(runCommand, {
    fail: card.fail,
    succeed: card.succeed,
  })
  const sendOnce = (command: () => PromiseLike<unknown> | undefined): void => {
    const claimed = shot.claim(command)
    if (claimed !== null) send(claimed)
  }
  const sirenTriggers = siren !== undefined && has('trigger')
  const sirenStops = siren !== undefined && has('stop')
  const switchSets = power.bound && card.implements('switch', 'setState')
  const motionSets = motion !== undefined && card.implements('motion-trigger', 'setMotionTrigger')
  return (
    <SirenCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        activity,
        since: power.since,
        canTrigger: sirenTriggers || switchSets,
        canStop: sirenStops || switchSets,
        commandPending: shot.inFlight,
        run: sirenRunOf(sirenSlice, activity === 'sounding'),
        adjustable: sirenTriggers ? sirenAdjustableOf(options.data) : sirenAdjustableOf(undefined),
        optionsUnavailable: sirenTriggers && readsOptions && options.isError,
        onMotion: motionSets && motionSlice !== undefined ? motionSlice.enabled : null,
        onMotionPending: motionShot.inFlight,
      }}
      actions={{
        ...card.actions,
        onTrigger: (amount) =>
          sendOnce(() =>
            sirenTriggers
              ? siren?.trigger(sirenTriggerInputOf(amount))
              : dev?.switch?.setState({ on: true }),
          ),
        onStop: () =>
          sendOnce(() => (sirenStops ? siren?.stop({}) : dev?.switch?.setState({ on: false }))),
        onMotion: (enabled) => {
          const claimed = motionShot.claim(() => motion?.setMotionTrigger({ enabled }))
          if (claimed !== null) send(claimed)
        },
      }}
    />
  )
}
