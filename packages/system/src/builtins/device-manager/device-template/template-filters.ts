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

/** What `+` / `~` give when an operand is unavailable: the whole output expression then prints as unavailable. */
class Unavailable {
  constructor() {
    Object.freeze(this)
  }
}
export const UNAVAILABLE_VALUE: object = new Unavailable()

function operandText(value: unknown): string | undefined {
  if (value instanceof Quantity) return `${value.value} ${value.symbol}`
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  return undefined
}

export function addChecked(left: unknown, right: unknown): unknown {
  if (typeof left === 'number' && typeof right === 'number') return left + right
  if (typeof left === 'string' || typeof right === 'string') return concatChecked(left, right)
  return UNAVAILABLE_VALUE
}

export function concatChecked(left: unknown, right: unknown): unknown {
  const a = operandText(left)
  const b = operandText(right)
  if (a === undefined || b === undefined || (typeof left === 'number' && Number.isNaN(left)))
    return UNAVAILABLE_VALUE
  if (typeof right === 'number' && Number.isNaN(right)) return UNAVAILABLE_VALUE
  return a + b
}

/** `range(n)`, `range(a, b)`, `range(a, b, step)` — integers only, never more than `RANGE_MAX` items. */
export const RANGE_MAX = 1000

export function rangeGlobal(...args: readonly unknown[]): readonly number[] {
  const numbers = args.map((arg) =>
    typeof arg === 'number' && Number.isInteger(arg) ? arg : Number.NaN,
  )
  if (numbers.length < 1 || numbers.length > 3 || numbers.some(Number.isNaN))
    throw new Error('range() takes integers')
  const [first = 0, second, third] = numbers
  const start = second === undefined ? 0 : first
  const stop = second === undefined ? first : second
  const step = third ?? 1
  if (step === 0) throw new Error('range() step cannot be 0')
  const count = Math.max(0, Math.ceil((stop - start) / step))
  if (count > RANGE_MAX) throw new Error(`range() is capped at ${RANGE_MAX} items`)
  return Array.from({ length: count }, (_, i) => start + i * step)
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

/**
 * `trunc(n)`: cut to `n` decimals toward zero, never round (19.99 at one decimal is 19.9).
 * The same arithmetic as the OSD's old formatter, so a migrated text prints what it did.
 */
export function truncFilter(input: unknown, digits: unknown): unknown {
  const places =
    typeof digits === 'number' && Number.isInteger(digits) && digits >= 0 && digits <= 12
      ? digits
      : 0
  const factor = 10 ** places
  if (input instanceof Quantity)
    return new Quantity(Math.trunc(input.value * factor) / factor, input.symbol)
  if (typeof input === 'number') return Math.trunc(input * factor) / factor
  return input
}

/** `onoff`: a boolean reads `ON` / `OFF`; anything else passes through untouched (a number stays a number). */
export function onoffFilter(input: unknown): unknown {
  if (input === true) return 'ON'
  if (input === false) return 'OFF'
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

const TIME_TOKENS: readonly string[] = ['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss']

/**
 * `time('HH:mm')`: an epoch timestamp as clock text, in the zone of the process
 * (the server's). Tokens `YYYY MM DD HH mm ss`; everything else is literal and a
 * source character is consumed once, so a substituted digit is never re-read.
 */
export function timeFilter(input: unknown, pattern: unknown): unknown {
  const at = epochMs(input)
  if (at === undefined || typeof pattern !== 'string') return undefined
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return undefined
  const two = (n: number): string => String(n).padStart(2, '0')
  const parts: Readonly<Record<string, string>> = {
    YYYY: String(date.getFullYear()).padStart(4, '0'),
    MM: two(date.getMonth() + 1),
    DD: two(date.getDate()),
    HH: two(date.getHours()),
    mm: two(date.getMinutes()),
    ss: two(date.getSeconds()),
  }
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const token = TIME_TOKENS.find((t) => pattern.startsWith(t, i))
    if (token !== undefined) {
      out += parts[token] ?? ''
      i += token.length
    } else {
      out += pattern[i]
      i += 1
    }
  }
  return out
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
export interface Printer {
  readonly print: (value: unknown) => string
  /** How many outputs printed as unavailable because an operand of `+` / `~` was. */
  readonly poisoned: () => number
}

export function makePrinter(unavailable: string): Printer {
  let poisoned = 0
  const print = (value: unknown): string => {
    if (value === UNAVAILABLE_VALUE) {
      poisoned += 1
      return unavailable
    }
    if (value instanceof String) return String(value)
    if (isMissing(value)) return unavailable
    if (value instanceof Quantity) return `${value.value} ${value.symbol}`
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (Array.isArray(value))
      return value.map((item) => (isMissing(item) ? unavailable : String(item))).join(', ')
    return unavailable
  }
  return { print, poisoned: () => poisoned }
}
