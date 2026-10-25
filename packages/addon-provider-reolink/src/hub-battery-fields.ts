/**
 * The hub boundary for the per-channel battery power fields.
 *
 * The Reolink hub/NVR reports `chargeStatus` and `adapterStatus` as NUMBERS
 * (0/1/2); the standalone camera path reports the same facts as strings, and
 * `deriveChargingSource` (`battery-charging.ts`) speaks only the string
 * vocabulary. This module is the translation, and — the part that was
 * missing — it NAMES a code it cannot translate instead of dropping the field
 * silently. A dropped field reads as "the push said nothing about power", so
 * a new firmware value would have kept the previous belief forever, with not
 * one log line. The ledger lets the hub warn once per (device, field, code).
 */

const CHARGE_STATUS_BY_CODE: Readonly<Record<number, string>> = {
  0: 'none',
  1: 'charging',
  2: 'chargeComplete',
}

const ADAPTER_STATUS_BY_CODE: Readonly<Record<number, string>> = {
  0: 'none',
  1: 'dc',
  2: 'solarPanel',
}

export type HubBatteryPowerField = 'chargeStatus' | 'adapterStatus'

export interface HubBatteryPowerFields {
  readonly chargeStatus?: string
  readonly adapterStatus?: string
}

export interface UnmappedHubBatteryCode {
  readonly field: HubBatteryPowerField
  readonly value: unknown
}

export interface HubBatteryPowerMapping {
  /** The fields that translated; an absent input field is absent here too. */
  readonly fields: HubBatteryPowerFields
  /** Present-but-untranslatable codes, for the caller to log. */
  readonly unmapped: readonly UnmappedHubBatteryCode[]
}

function mapOne(
  field: HubBatteryPowerField,
  value: unknown,
  byCode: Readonly<Record<number, string>>,
): { mapped?: string; unmapped?: UnmappedHubBatteryCode } {
  if (value === undefined || value === null) return {}
  if (typeof value === 'string') return { mapped: value }
  if (typeof value === 'number') {
    const mapped = byCode[value]
    if (mapped !== undefined) return { mapped }
  }
  return { unmapped: { field, value } }
}

/** Translate one channel's raw CGI power fields; never throws. */
export function mapHubBatteryPower(
  cgi: Readonly<Record<string, unknown>> | undefined,
): HubBatteryPowerMapping {
  const charge = mapOne('chargeStatus', cgi?.['chargeStatus'], CHARGE_STATUS_BY_CODE)
  const adapter = mapOne('adapterStatus', cgi?.['adapterStatus'], ADAPTER_STATUS_BY_CODE)
  return {
    fields: {
      ...(charge.mapped !== undefined ? { chargeStatus: charge.mapped } : {}),
      ...(adapter.mapped !== undefined ? { adapterStatus: adapter.mapped } : {}),
    },
    unmapped: [
      ...(charge.unmapped !== undefined ? [charge.unmapped] : []),
      ...(adapter.unmapped !== undefined ? [adapter.unmapped] : []),
    ],
  }
}

/**
 * Remembers which (device, field, code) triples were already reported, so a
 * polled read warns once per finding and not once per tick. Unbounded only in
 * theory: the key space is a few cameras times two fields times the handful of
 * codes a firmware can invent.
 */
export class UnmappedCodeLedger {
  private readonly seen = new Set<string>()

  firstSeen(deviceId: number, field: HubBatteryPowerField, value: unknown): boolean {
    const key = `${deviceId}:${field}:${String(value)}`
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }
}
