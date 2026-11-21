/**
 * Battery detail rows — the selection and formatting logic behind the
 * battery popover on the device detail. Pure: it decides WHICH facts are
 * known and what they read as; labels are translated by the renderer.
 *
 * A fact that is absent, `null` or `'unknown'` yields NO row — never a `0`
 * or an "idle" (D315 / D393). `sleeping` is a boolean, so it is always known.
 */
import { formatNumeric } from '../lib/format-numeric'
import type { BatteryStatusLike } from './battery-badge'

export type BatteryDetailId =
  | 'source'
  | 'cell'
  | 'voltage'
  | 'current'
  | 'temperature'
  | 'sleep'
  | 'lastContact'

/** Which translated phrase a row's value uses (renderer maps it to a key). */
export type BatteryDetailValue =
  | { readonly kind: 'phrase'; readonly phrase: string }
  | { readonly kind: 'number'; readonly text: string }
  | {
      readonly kind: 'ago'
      readonly unit: 'now' | 'minutes' | 'hours' | 'days'
      readonly count: number
    }

export interface BatteryDetailRow {
  readonly id: BatteryDetailId
  readonly value: BatteryDetailValue
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Below this a timestamp is a placeholder, never a real instant. */
const MIN_PLAUSIBLE_MS = Date.UTC(2000, 0, 1)

function isKnownNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function formatNumber(value: number, unit: string): BatteryDetailValue {
  return { kind: 'number', text: `${formatNumeric(value, undefined)} ${unit}` }
}

export function batteryAge(
  timestampMs: number,
  now: number,
): Extract<BatteryDetailValue, { kind: 'ago' }> {
  const delta = now - timestampMs
  if (delta < MINUTE_MS) return { kind: 'ago', unit: 'now', count: 0 }
  if (delta < HOUR_MS) return { kind: 'ago', unit: 'minutes', count: Math.floor(delta / MINUTE_MS) }
  if (delta < DAY_MS) return { kind: 'ago', unit: 'hours', count: Math.floor(delta / HOUR_MS) }
  return { kind: 'ago', unit: 'days', count: Math.floor(delta / DAY_MS) }
}

export function batteryDetailRows(
  status: BatteryStatusLike,
  now: number = Date.now(),
): readonly BatteryDetailRow[] {
  const rows: BatteryDetailRow[] = []

  if (status.charging === 'dc')
    rows.push({ id: 'source', value: { kind: 'phrase', phrase: 'mains' } })
  else if (status.charging === 'solar')
    rows.push({ id: 'source', value: { kind: 'phrase', phrase: 'solar' } })
  else if (status.charging === 'none')
    rows.push({ id: 'source', value: { kind: 'phrase', phrase: 'batteryOnly' } })

  if (status.chargeState === 'charging')
    rows.push({ id: 'cell', value: { kind: 'phrase', phrase: 'charging' } })
  else if (status.chargeState === 'full')
    rows.push({ id: 'cell', value: { kind: 'phrase', phrase: 'full' } })
  else if (status.chargeState === 'idle')
    rows.push({ id: 'cell', value: { kind: 'phrase', phrase: 'notCharging' } })

  if (isKnownNumber(status.voltage))
    rows.push({ id: 'voltage', value: formatNumber(status.voltage, 'V') })
  if (isKnownNumber(status.currentMa))
    rows.push({ id: 'current', value: formatNumber(status.currentMa, 'mA') })
  if (isKnownNumber(status.temperatureC))
    rows.push({ id: 'temperature', value: formatNumber(status.temperatureC, '°C') })

  rows.push({
    id: 'sleep',
    value: { kind: 'phrase', phrase: status.sleeping ? 'asleep' : 'awake' },
  })

  if (isKnownNumber(status.lastContactAt) && status.lastContactAt >= MIN_PLAUSIBLE_MS)
    rows.push({ id: 'lastContact', value: batteryAge(status.lastContactAt, now) })

  return rows
}
