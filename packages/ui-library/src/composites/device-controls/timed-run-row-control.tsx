/**
 * The list-row timed run (D993): the shared compact control (`TimedRunQuick`) beside the
 * power control. Drawn only when the device binds `timed-run`, which is every device that has
 * a switch (D1097). The bound is the same limit the hub refuses against; the value is the
 * device's own saved one-tap run.
 */
import type { ReactNode } from 'react'
import { timedRunLimitOf } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { TimedRunQuick } from './timed-run-quick'
import { timedRunQuickCalls, timedRunQuickView } from './timed-run-quick-model'

export interface TimedRunRowControlProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly deviceId: number
  readonly deviceType: string
  /** With the type, which device this is: the role narrows the limit (a heater runs longer, a siren shorter). */
  readonly deviceRole: string | null
  readonly className?: string
}

export function TimedRunRowControl({
  trpc,
  deviceId,
  deviceType,
  deviceRole,
  className,
}: TimedRunRowControlProps): ReactNode {
  const limit = timedRunLimitOf(deviceType, deviceRole)
  const { cap, slice, online } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.timedRun,
    slice: (d) => d.state.timedRun,
  })
  if (cap === undefined) return null
  return (
    <TimedRunQuick
      {...timedRunQuickView(limit, slice)}
      {...timedRunQuickCalls(cap, limit.unit)}
      online={online}
      className={className}
    />
  )
}
