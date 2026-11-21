import type { ErrorStatus } from '@camstack/types'
import type { HmDevice } from 'nodehomematic'
import { maintenanceChannel } from './ccu/ccu-device-rows.js'
import { faultSince } from './ccu/ccu-faults-actions.js'
import type { ServiceMessage } from './ccu/ccu-schemas.js'
import { RADIO_UNREACHABLE_FAULT, ruleReading } from './homematic-fault-mapping.js'
import { radioInterfaceOfDevice } from './homematic-radio-interface.js'

/** At least this many HmIP-RF devices must have gone unreachable together. */
export const RADIO_UNREACHABLE_MIN_DEVICES = 3
/** … and at least this fraction of the interface's devices. */
export const RADIO_UNREACHABLE_MIN_FRACTION = 0.25
/** … each with an UNREACH start inside one window of this length. */
export const RADIO_UNREACHABLE_WINDOW_MS = 10 * 60_000

type MessageStamp = Pick<ServiceMessage, 'address' | 'type' | 'timestamp'>

function unreachOf(device: HmDevice): boolean | null {
  const point = maintenanceChannel(device)?.dataPoints.find((p) => p.parameter === 'UNREACH')
  return typeof point?.value === 'boolean' ? point.value : null
}

/** The most UNREACH starts that fall inside any one window. */
function largestCluster(starts: readonly number[]): number {
  const sorted = [...starts].sort((a, b) => a - b)
  let best = 0
  let low = 0
  for (let high = 0; high < sorted.length; high += 1) {
    while ((sorted[high] ?? 0) - (sorted[low] ?? 0) > RADIO_UNREACHABLE_WINDOW_MS) low += 1
    best = Math.max(best, high - low + 1)
  }
  return best
}

/**
 * Active when several HmIP-RF devices became UNREACH close together: enough of
 * them AND enough of the interface. A device whose UNREACH start the CCU did not
 * stamp cannot be placed in a window and is not counted. The population is the
 * HmIP-RF devices whose flag was read; none read is UNKNOWN, never "fine".
 */
export function radioUnreachableReading(
  devices: readonly HmDevice[],
  messages: readonly MessageStamp[],
  now: number,
): ErrorStatus {
  const starts: number[] = []
  let population = 0
  for (const device of devices) {
    if (radioInterfaceOfDevice(device) !== 'HmIP-RF') continue
    const unreach = unreachOf(device)
    if (unreach === null) continue
    population += 1
    if (!unreach) continue
    const since = faultSince(device.address, 'UNREACH', messages)
    if (since !== null) starts.push(since)
  }
  if (population === 0) return ruleReading(RADIO_UNREACHABLE_FAULT, null, now)
  const clustered = largestCluster(starts)
  const active =
    clustered >= RADIO_UNREACHABLE_MIN_DEVICES &&
    clustered / population >= RADIO_UNREACHABLE_MIN_FRACTION
  return ruleReading(RADIO_UNREACHABLE_FAULT, active, now)
}
