/**
 * One power reading becomes a washer, dryer or dishwasher (D944 helper).
 *
 * Standby of the control board is under 5 W; a motor or a heater is far
 * above that, so 5 W is the line. A door lock or a short pump spike is not
 * a cycle, so running starts only after 30 s above the line.
 *
 * A wash, dry or dishwasher pause (soak, heat-wait, heater off between
 * bursts) lasts several minutes. Ending the cycle on the first dip would
 * report "finished" in the middle of the program, so the stop dwell is
 * 10 minutes on every type. The number is stored per type so one machine
 * can move later without moving the others.
 */
import { DeviceType } from '../../device/device-type.js'
import type { CompositionSourceRef } from '../source-ref.js'
import type { SourcePickRequest } from './source-pick.js'

export const APPLIANCE_TEMPLATE_ID = 'appliance' as const

export const APPLIANCE_KINDS = ['washer', 'dryer', 'dishwasher'] as const
export type ApplianceKind = (typeof APPLIANCE_KINDS)[number]

export interface ApplianceDefaults {
  readonly thresholdWatts: number
  readonly startDwellMs: number
  readonly stopDwellMs: number
}

const START_DWELL_MS = 30_000
const STOP_DWELL_MS = 600_000
const THRESHOLD_WATTS = 5

export const APPLIANCE_DEFAULTS: Readonly<Record<ApplianceKind, ApplianceDefaults>> = {
  washer: {
    thresholdWatts: THRESHOLD_WATTS,
    startDwellMs: START_DWELL_MS,
    stopDwellMs: STOP_DWELL_MS,
  },
  dryer: {
    thresholdWatts: THRESHOLD_WATTS,
    startDwellMs: START_DWELL_MS,
    stopDwellMs: STOP_DWELL_MS,
  },
  dishwasher: {
    thresholdWatts: THRESHOLD_WATTS,
    startDwellMs: START_DWELL_MS,
    stopDwellMs: STOP_DWELL_MS,
  },
}

const DEVICE_TYPE: Readonly<Record<ApplianceKind, DeviceType>> = {
  washer: DeviceType.Washer,
  dryer: DeviceType.Dryer,
  dishwasher: DeviceType.Dishwasher,
}

export function applianceDeviceType(kind: ApplianceKind): DeviceType {
  return DEVICE_TYPE[kind]
}

export function isApplianceKind(value: string): value is ApplianceKind {
  return APPLIANCE_KINDS.some((kind) => kind === value)
}

/** The member step: one watts reading, from a sensor or from the plug itself. */
export function sourcePickForAppliance(): SourcePickRequest {
  return {
    purpose: 'reading',
    multiple: false,
    max: 1,
    deviceTypes: [DeviceType.Sensor, DeviceType.Switch],
    accept: [{ cap: 'power-meter', fieldPath: 'watts', valueKind: 'number' }],
    history: { required: false, minRetentionMs: null },
    mustBindCaps: [],
    exclude: [] as readonly CompositionSourceRef[],
  }
}
