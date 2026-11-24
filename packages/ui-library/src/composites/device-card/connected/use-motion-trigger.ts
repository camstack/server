import { readMotionTrigger } from '../../../hooks/motion-trigger-reading'
import { useTrpcClient } from '../../../contexts/system-context'
import { useDeviceCommand } from '../../../hooks/use-device-command'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOneShotCommand } from '../../../hooks/use-one-shot-command'
import { type CommandNotice, reportedCommand } from './use-command-notice'

export interface MotionTriggerControl {
  /**
   * The device binds `motion-trigger`, can set it, and its slice has answered: the
   * card draws the corner. False otherwise.
   */
  readonly present: boolean
  /**
   * "On motion" as the slice reports it; null while the slice holds only the
   * cold-start seed (the camera was never read), or when `present` is false.
   */
  readonly on: boolean | null
  /** A change is in flight: the toggle waits for the server. */
  readonly pending: boolean
  readonly onToggle: (enabled: boolean) => void
}

interface MotionTriggerArgs extends Pick<CommandNotice, 'fail' | 'succeed'> {
  readonly deviceId: number
  /** The device's binding of `motion-trigger` implements `setMotionTrigger`. */
  readonly settable: boolean
}

/**
 * The slice and setter behind every connected card's "on motion" toggle. One claim per
 * change, so a double tap sends once; the card shows the served value (D1061).
 */
export function useMotionTrigger({
  deviceId,
  settable,
  fail,
  succeed,
}: MotionTriggerArgs): MotionTriggerControl {
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const motion = dev?.motionTrigger
  const slice = useDeviceStateSlice(motion === undefined ? undefined : dev?.state.motionTrigger)
  const runCommand = useDeviceCommand()
  const shot = useOneShotCommand()
  const send = reportedCommand(runCommand, { fail, succeed })
  const sets = motion !== undefined && settable
  return {
    present: sets && slice !== undefined,
    on: sets && slice !== undefined ? onOf(slice) : null,
    pending: shot.inFlight,
    onToggle: (enabled) => {
      const claimed = shot.claim(() => motion?.setMotionTrigger({ enabled }))
      if (claimed !== null) send(claimed)
    },
  }
}

function onOf(slice: Parameters<typeof readMotionTrigger>[0]): boolean | null {
  const reading = readMotionTrigger(slice)
  return reading === 'unknown' ? null : reading === 'on'
}
