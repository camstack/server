/**
 * A dumb plug-in stove or heater, built from a smart plug (a `Heater`).
 *
 * The plug is the actuator: `switch.setState` is a FORWARD to the plug's own
 * (D967), so the heater switches exactly as the plug does. Running is the
 * plug being on; when a power reading is also named, running is the draw
 * staying above the line instead (a plug left on with the stove's own
 * thermostat open is not heating). 50 W is far above any standby and below
 * the smallest radiator.
 */
import { DeviceType } from '../../device/device-type.js'
import type { CompositionSourceRef } from '../source-ref.js'
import type { SourcePickRequest } from './source-pick.js'

export const HEATER_TEMPLATE_ID = 'heater' as const

export const HEATER_THRESHOLD_WATTS = 50
export const HEATER_START_DWELL_MS = 30_000
export const HEATER_STOP_DWELL_MS = 60_000

export const HEATER_DEVICE_TYPE: DeviceType = DeviceType.Heater

/** The plug the heater is built from: a switch, optionally metered. */
export function sourcePickForHeaterPlug(): SourcePickRequest {
  return {
    fieldChoice: 'operator',
    purpose: 'member',
    multiple: false,
    max: 1,
    deviceTypes: [DeviceType.Switch],
    accept: [{ cap: 'switch', fieldPath: 'on', valueKind: 'boolean' }],
    history: { required: false, minRetentionMs: null },
    mustBindCaps: ['switch'],
    exclude: [] as readonly CompositionSourceRef[],
  }
}
