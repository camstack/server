/**
 * Pure text formatting for an overlay slot. No I/O, no clock of its own —
 * `formatClock` takes the instant so a test can pin it.
 */
import type { OsdSlotBinding } from '@camstack/types'

/** Tokens `formatClock` understands. Anything else in the pattern is literal. */
const CLOCK_TOKENS: readonly string[] = ['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss']

interface ClockParts {
  readonly YYYY: string
  readonly MM: string
  readonly DD: string
  readonly HH: string
  readonly mm: string
  readonly ss: string
}

function clockParts(atMs: number, timezone?: string): ClockParts {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const found = new Map<string, string>()
  for (const part of fmt.formatToParts(new Date(atMs))) found.set(part.type, part.value)
  // Intl renders midnight as hour "24" in some ICU builds for hour12:false.
  const hour = found.get('hour') ?? '00'
  return {
    YYYY: found.get('year') ?? '0000',
    MM: found.get('month') ?? '00',
    DD: found.get('day') ?? '00',
    HH: hour === '24' ? '00' : hour,
    mm: found.get('minute') ?? '00',
    ss: found.get('second') ?? '00',
  }
}

/**
 * Render a clock pattern. Tokens are replaced longest-first so `MM` inside
 * a pattern that also contains `mm` cannot be half-consumed, and each
 * source character is consumed exactly once — a substitution never
 * re-matches text a previous substitution produced.
 */
export function formatClock(atMs: number, pattern: string, timezone?: string): string {
  if (!Number.isFinite(atMs)) return ''
  let parts: ClockParts
  try {
    parts = clockParts(atMs, timezone)
  } catch {
    // An unknown IANA zone throws inside Intl. Fall back to server time
    // rather than rendering nothing — a wrong-zone clock is still a clock.
    parts = clockParts(atMs)
  }
  const lookup: Record<string, string> = { ...parts }
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const token = CLOCK_TOKENS.find((t) => pattern.startsWith(t, i))
    if (token !== undefined) {
      out += lookup[token] ?? ''
      i += token.length
      continue
    }
    out += pattern[i]
    i += 1
  }
  return out
}

/**
 * Truncate a number to `maxDecimals` places. Truncation, not rounding:
 * `maxDecimals: 0` must yield an integer for firmwares that reject `.`,
 * and rounding 0.96 up to 1 there would be the same character either way
 * while rounding 19.99 to 20 would not.
 */
export function truncateDecimals(value: number, maxDecimals: number): string {
  if (!Number.isFinite(value)) return ''
  if (maxDecimals <= 0) return String(Math.trunc(value))
  const factor = 10 ** maxDecimals
  const truncated = Math.trunc(value * factor) / factor
  return String(truncated)
}

/** Cut to `max` characters, spending the last three on an ellipsis. */
export function limitText(text: string, max: number | undefined): string {
  if (max === undefined || max <= 0) return text
  if (text.length <= max) return text
  if (max <= 3) return text.slice(0, max)
  return `${text.slice(0, max - 3)}...`
}

/** Turn a raw state value into the string that goes into `${value}`. */
export function displayValue(
  raw: unknown,
  binding: OsdSlotBinding,
  maxDecimals: number = binding.maxDecimals,
): string {
  const mapped = binding.valueMap?.[String(raw)]
  if (mapped !== undefined) return mapped
  if (typeof raw === 'number') return truncateDecimals(raw, maxDecimals)
  if (typeof raw === 'boolean') return raw ? 'ON' : 'OFF'
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'string') return raw
  return String(raw)
}

/**
 * Substitute the template. `replaceAll`, not `replace` — a template that
 * mentions `${value}` twice must render it twice.
 */
export function applyTemplate(template: string, value: string, unit: string): string {
  return template.replaceAll('${value}', value).replaceAll('${unit}', unit)
}

export interface FormatSlotOptions {
  /** Already-converted numeric value (unit conversion applied upstream). */
  readonly displayRaw?: unknown
  /** Unit string for `${unit}` — from unit conversion / displayUnit. */
  readonly unit?: string
  /**
   * Firmware ceiling from the device-scope `osd` overlay (`maxCharacters`).
   * Never from the binding — the manager does not own this number.
   */
  readonly maxCharacters?: number
}

/** The whole formatting chain: raw value → the text to burn into the slot. */
export function formatSlotText(
  raw: unknown,
  binding: OsdSlotBinding,
  options: FormatSlotOptions = {},
): string {
  const value = displayValue(options.displayRaw ?? raw, binding)
  const unit = options.unit ?? ''
  const text = applyTemplate(binding.template, value, unit)
  return limitText(text.trim(), options.maxCharacters)
}
