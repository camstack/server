/**
 * The pure half of the daylight-phase card: the local draft the operator edits
 * and its conversion to and from the capability's settings. Nothing here judges
 * day or night: the phase and the reason come from `daylightPhase.getPhase`.
 */
import type { DaylightSettings } from '@dominevo/types'

/** What a fresh sensor choice starts from. */
export const DEFAULT_DARK_BELOW_LUX = 10
export const DEFAULT_HYSTERESIS_LUX = 5
export const DEFAULT_MIN_DWELL_MIN = 10

export interface DaylightSensorPick {
  readonly deviceId: number
  readonly cap: string
  readonly fieldPath: string
}

export interface DaylightDraft {
  readonly source: 'sun' | 'sensor'
  /** The picked value (device, cap, field); null until one is picked. */
  readonly sensor: DaylightSensorPick | null
  readonly darkBelow: number
  readonly hysteresis: number
  readonly minDwellMin: number
}

export function draftOfSettings(settings: DaylightSettings): DaylightDraft {
  if (settings.source === 'sun') {
    return {
      source: 'sun',
      sensor: null,
      darkBelow: DEFAULT_DARK_BELOW_LUX,
      hysteresis: DEFAULT_HYSTERESIS_LUX,
      minDwellMin: DEFAULT_MIN_DWELL_MIN,
    }
  }
  return {
    source: 'sensor',
    sensor: { deviceId: settings.deviceId, cap: settings.cap, fieldPath: settings.fieldPath },
    darkBelow: settings.darkBelow,
    hysteresis: settings.hysteresis,
    minDwellMin: settings.minDwellMin,
  }
}

/** The settings to save, or null while the draft cannot be saved (the sensor is not picked yet). */
export function settingsOfDraft(draft: DaylightDraft): DaylightSettings | null {
  if (draft.source === 'sun') return { source: 'sun' }
  if (draft.sensor === null) return null
  return {
    source: 'sensor',
    deviceId: draft.sensor.deviceId,
    cap: draft.sensor.cap,
    fieldPath: draft.sensor.fieldPath,
    darkBelow: draft.darkBelow,
    hysteresis: Math.max(0, draft.hysteresis),
    minDwellMin: Math.max(0, Math.min(1440, Math.round(draft.minDwellMin))),
  }
}

/** 0 when the draft equals what the server holds (hides the save bar), else 1. */
export function pendingChanges(saved: DaylightSettings, draft: DaylightDraft): number {
  const next = settingsOfDraft(draft)
  if (next === null) return 1
  return JSON.stringify(next) === JSON.stringify(saved) ? 0 : 1
}
