import { ERROR_STATUS_COLD, type DeviceFault, type ErrorStatus } from '@dominevo/types'
import type { HomeComBridgeFault } from './homecom-bridge.js'

/**
 * The faults a HomeCom gateway reports (`/resource/notifications`) as the `error` cap slice.
 * `null` is a read that was refused or failed: unknown (`active: null`), never "no fault".
 */

function faultOf(fault: HomeComBridgeFault): DeviceFault {
  return {
    code: fault.code,
    label: `HomeCom fault ${fault.code}`,
    severity: fault.severity,
  }
}

export function homeComFaultReading(
  faults: readonly HomeComBridgeFault[] | null,
  now: number,
): ErrorStatus {
  if (faults === null) return { ...ERROR_STATUS_COLD, lastFetchedAt: now }
  const raised = faults.filter((f) => f.active).map(faultOf)
  const principal = raised.find((f) => f.severity === 'error') ?? raised[0]
  if (principal === undefined) {
    return { ...ERROR_STATUS_COLD, active: false, lastFetchedAt: now }
  }
  return {
    active: true,
    code: principal.code,
    label: principal.label,
    severity: principal.severity,
    since: null,
    faults: raised,
    lastFetchedAt: now,
  }
}
