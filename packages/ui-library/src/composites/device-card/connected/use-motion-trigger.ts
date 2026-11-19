import { useTrpcClient } from '../../../contexts/system-context'
import { useDeviceCommand } from '../../../hooks/use-device-command'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOneShotCommand } from '../../../hooks/use-one-shot-command'
import type { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

export interface MotionTriggerControl {
  /**
   * "On motion" as the device's `motion-trigger` slice reports it; null when the
   * device binds none, cannot set it, or the slice has not answered yet.
   */
  readonly on: boolean | null
  /** A change is in flight: the toggle waits for the server. */
  readonly pending: boolean
  readonly onToggle: (enabled: boolean) => void
}

interface MotionTriggerArgs {
  readonly deviceId: number
  readonly card: ReturnType<typeof useCardCommon>
}

/**
 * The slice and setter behind every card's "on motion" toggle. One claim per
 * change, so a double tap sends once; the card shows the served value (D1061).
 */
export function useMotionTrigger({ deviceId, card }: MotionTriggerArgs): MotionTriggerControl {
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const motion = dev?.motionTrigger
  const slice = useDeviceStateSlice(motion === undefined ? undefined : dev?.state.motionTrigger)
  const runCommand = useDeviceCommand()
  const shot = useOneShotCommand()
  const send = reportedCommand(runCommand, { fail: card.fail, succeed: card.succeed })
  const sets = motion !== undefined && card.implements('motion-trigger', 'setMotionTrigger')
  return {
    on: sets && slice !== undefined ? slice.enabled : null,
    pending: shot.inFlight,
    onToggle: (enabled) => {
      const claimed = shot.claim(() => motion?.setMotionTrigger({ enabled }))
      if (claimed !== null) send(claimed)
    },
  }
}
