/**
 * The device-list row of a `DeviceType.Washer` / `DeviceType.Dryer` device:
 * the running badge round the drum icon (the `running-state` cap). The
 * device-detail hero is the device card (`composites/device-card`,
 * `ConnectedApplianceCard`).
 *
 * UNKNOWN IS NOT OFF (D393). `running: null` stays unbadged.
 */
import { WashingMachine } from 'lucide-react'
import type { ReactNode } from 'react'
import type { RunningStateStatus } from '@camstack/types'
import { useDeviceState } from '../../hooks/use-device-proxy'
import { RunningBadge } from '../running-badge'
import type { DeviceControlProps } from './control-registry'

export function ApplianceInlineControl(props: DeviceControlProps): ReactNode {
  const running = useDeviceState<RunningStateStatus>(
    props.trpc,
    props.deviceId,
    (s) => s.runningState,
  )
  return (
    <div className="inline-flex items-center gap-1.5 max-w-full">
      <RunningBadge running={running?.running ?? null}>
        <WashingMachine className="h-4 w-4 text-foreground-muted" aria-hidden />
      </RunningBadge>
    </div>
  )
}
