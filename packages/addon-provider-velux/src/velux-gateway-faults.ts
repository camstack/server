import { type DeviceFault, ERROR_STATUS_COLD, type ErrorStatus } from '@dominevo/types'
import type { VeluxNodeSource } from './velux-node-resolver.js'

/** How long the gateway must stay unreachable before it is a fault of its own (below it: `connection-lost`). */
export const VELUX_UNREACHABLE_FAULT_MS = 2 * 60_000

export const VELUX_FAULT_UNREACHABLE = 'unreachable'
export const VELUX_FAULT_AUTH_FAILED = 'auth-failed'
export const VELUX_FAULT_CONNECTION_LOST = 'connection-lost'

/** Every fault code the gateway can raise, with its words and loudness. */
export const VELUX_GATEWAY_FAULT_TYPES: readonly DeviceFault[] = [
  {
    code: VELUX_FAULT_UNREACHABLE,
    label: 'Gateway unreachable',
    severity: 'error',
  },
  {
    code: VELUX_FAULT_AUTH_FAILED,
    label: 'Gateway login refused',
    severity: 'error',
  },
  {
    code: VELUX_FAULT_CONNECTION_LOST,
    label: 'Gateway session down',
    severity: 'warning',
  },
]

function faultOf(code: string): DeviceFault {
  const found = VELUX_GATEWAY_FAULT_TYPES.find((f) => f.code === code)
  if (found === undefined) throw new Error(`unknown Velux gateway fault code: ${code}`)
  return found
}

function raised(code: string, since: number | null, now: number): ErrorStatus {
  const fault = faultOf(code)
  return {
    active: true,
    code: fault.code,
    label: fault.label,
    severity: fault.severity,
    since,
    faults: [fault],
    lastFetchedAt: now,
  }
}

/** What the fault reading reads off a gateway manager. */
export type VeluxFaultSource = Pick<
  VeluxNodeSource,
  'status' | 'attempted' | 'loginRefused' | 'unreachableSince' | 'lastError'
>

/**
 * The fault the gateway session shows right now. Unknown (`active: null`)
 * before the first connect attempt, while a connect is in flight, and when the
 * session is not ours to judge; `false` once connected.
 */
export function veluxGatewayFaultReading(
  source: VeluxFaultSource | null,
  now: number,
): ErrorStatus {
  const unknown: ErrorStatus = { ...ERROR_STATUS_COLD, lastFetchedAt: now }
  if (source === null || !source.attempted) return unknown
  if (source.status === 'connected') {
    return { ...ERROR_STATUS_COLD, active: false, lastFetchedAt: now }
  }
  if (source.status === 'connecting') return unknown
  if (source.loginRefused) return raised(VELUX_FAULT_AUTH_FAILED, null, now)
  const since = source.unreachableSince
  if (since !== null && now - since >= VELUX_UNREACHABLE_FAULT_MS) {
    return raised(VELUX_FAULT_UNREACHABLE, since, now)
  }
  // A manager stopped on purpose is 'disconnected' with no error: not a fault.
  if (source.status === 'error' || source.lastError !== null) {
    return raised(VELUX_FAULT_CONNECTION_LOST, null, now)
  }
  return unknown
}
