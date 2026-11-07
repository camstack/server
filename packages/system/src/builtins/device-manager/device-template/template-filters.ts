/**
 * The filters a device template may use, as the worker runs them.
 *
 * `unit(x, '°F')` converts from the field's D944 base unit (the renderer
 * inserts the source unit as a hidden first argument) with the SAME table the
 * rest of the product converts with, and appends the symbol. A value that is
 * not a number, or a pair the table cannot convert, passes through (identity
 * plus the symbol for the latter) — never a wrong number.
 */
import { tryConvertUnit } from '@camstack/types/units-lean'

/** A number with a unit symbol: what `unit()` returns and `round`/`format`/`default` accept. */
export class Quantity {
  constructor(
    readonly value: number,
    readonly symbol: string,
  ) {
    Object.freeze(this)
  }
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'number' && Number.isNaN(value))
}

export function unitFilter(input: unknown, from: unknown, to: unknown): unknown {
  if (typeof input !== 'number' || typeof to !== 'string') return input
  const converted =
    typeof from === 'string' && from !== '' ? tryConvertUnit(input, from, to) : undefined
  return new Quantity(converted ?? input, to)
}

export function roundFilter(input: unknown, digits: unknown): unknown {
  const places =
    typeof digits === 'number' && Number.isInteger(digits) && digits >= 0 && digits <= 12
      ? digits
      : 0
  const factor = 10 ** places
  if (input instanceof Quantity)
    return new Quantity(Math.round(input.value * factor) / factor, input.symbol)
  if (typeof input === 'number') return Math.round(input * factor) / factor
  return input
}

export function defaultFilter(input: unknown, fallback: unknown): unknown {
  return isMissing(input) ? fallback : input
}

function epochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

function durationText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/** `since`: how long ago a timestamp was, as `5 min`. `nowMs` comes with the request, never from a clock in the worker. */
export function makeSinceFilter(nowMs: number): (input: unknown) => unknown {
  return (input) => {
    const at = epochMs(input)
    return at === undefined ? undefined : durationText(nowMs - at)
  }
}

/** `ago`: `5 min ago`. */
export function makeAgoFilter(nowMs: number): (input: unknown) => unknown {
  return (input) => {
    const at = epochMs(input)
    return at === undefined ? undefined : `${durationText(nowMs - at)} ago`
  }
}

/** `format('%.1f')`, `format('%d items')`, `format('%s')`: one value, one placeholder. */
export function formatFilter(input: unknown, pattern: unknown): unknown {
  if (typeof pattern !== 'string') return input
  const value = input instanceof Quantity ? input.value : input
  const suffix = input instanceof Quantity ? ` ${input.symbol}` : ''
  if (isMissing(value)) return undefined
  const text = pattern.replace(/%(?:\.(\d{1,2})f|d|s)/, (match, digits: string | undefined) => {
    if (typeof value === 'number') {
      if (digits !== undefined) return value.toFixed(Number(digits))
      return match === '%d' ? String(Math.trunc(value)) : String(value)
    }
    return String(value)
  })
  return `${text}${suffix}`
}

/** What `{{ … }}` prints. Unknown values read as `unavailable`; objects never print their shape. */
export function makePrinter(unavailable: string): (value: unknown) => string {
  return (value) => {
    if (isMissing(value)) return unavailable
    if (value instanceof Quantity) return `${value.value} ${value.symbol}`
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (Array.isArray(value))
      return value.map((item) => (isMissing(item) ? unavailable : String(item))).join(', ')
    return unavailable
  }
}
