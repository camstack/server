/**
 * A device value field names its QUANTITY, never its unit. The unit of a
 * reading is the D944 base of its quantity, declared once on the field and
 * converted at the display edge, so a field called `watts` or `rssiDbm` is a
 * second, wrong declaration of it. Judgement is pure so a spec can build a
 * fixture.
 */
import { z } from 'zod'
import type { CapabilityHistory } from '../../packages/types/src/capabilities/capability-definition.js'

export interface FieldNameCap {
  readonly capName: string
  readonly scope: 'device' | 'system'
  readonly runtimeState: z.ZodType | undefined
  readonly history: CapabilityHistory | undefined
}

export interface FieldNameViolation {
  readonly capName: string
  readonly path: string
  readonly message: string
}

/** A field that stays although it looks like a unit, with the reason it does. */
export interface FieldNameAllowance {
  readonly key: string
  readonly reason: string
}

/** Whole-word unit names: a field called exactly this is a unit, not a quantity. */
const UNIT_NAMES: ReadonlySet<string> = new Set([
  'watts',
  'watt',
  'volts',
  'volt',
  'amps',
  'amp',
  'kwh',
  'kwhtotal',
  'celsius',
  'fahrenheit',
  'kelvin',
  'hpa',
  'lux',
  'mireds',
  'mired',
  'percent',
  'percentage',
  'ppm',
  'ppb',
  'dbm',
  'va',
])

/**
 * Unit words a longer camelCase field name may end in. Durations (`Ms`, `Sec`)
 * are not here: a duration is configuration with no quantity name besides
 * itself, and the field is not a device reading.
 */
const UNIT_SUFFIXES: readonly string[] = [
  'Percent',
  'Pct',
  'Ppm',
  'Ppb',
  'Dbm',
  'Kwh',
  'Watts',
  'Volts',
  'Amps',
  'Celsius',
  'Fahrenheit',
  'Kelvin',
  'Hpa',
  'Lux',
  'Mireds',
]

/** Whether `name` (one path segment) is a unit name or ends in a unit word. */
export function looksLikeUnit(name: string): boolean {
  if (UNIT_NAMES.has(name.toLowerCase())) return true
  return UNIT_SUFFIXES.some((suffix) => name.length > suffix.length && name.endsWith(suffix))
}

function peel(schema: z.ZodType): z.ZodType {
  let current = schema
  for (let guard = 0; guard < 16; guard += 1) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodReadonly ||
      current instanceof z.ZodCatch
    ) {
      current = current.unwrap()
    } else {
      return current
    }
  }
  return current
}

function collectPaths(schema: z.ZodType, prefix: string, out: string[]): void {
  const root = peel(schema)
  if (root instanceof z.ZodObject) {
    for (const [key, field] of Object.entries(root.shape)) {
      if (!(field instanceof z.ZodType)) continue
      const path = prefix.length > 0 ? `${prefix}.${key}` : key
      out.push(path)
      collectPaths(field, path, out)
    }
    return
  }
  if (root instanceof z.ZodArray && root.element instanceof z.ZodType) {
    collectPaths(root.element, prefix, out)
  }
}

function historyPaths(history: CapabilityHistory | undefined): readonly string[] {
  if (history === undefined || history === 'none') return []
  return [...Object.keys(history.fields), ...Object.keys(history.items?.fields ?? {})]
}

/** Every status or history field of a device-scoped cap whose name is a unit. */
export function judgeFieldNames(
  cap: FieldNameCap,
  allowed: ReadonlyMap<string, string>,
): readonly FieldNameViolation[] {
  if (cap.scope !== 'device') return []
  const paths: string[] = []
  if (cap.runtimeState !== undefined) collectPaths(cap.runtimeState, '', paths)
  paths.push(...historyPaths(cap.history))
  const seen = new Set<string>()
  const out: FieldNameViolation[] = []
  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)
    const name = path.split('.').pop() ?? path
    if (!looksLikeUnit(name)) continue
    if (allowed.has(`${cap.capName}.${path}`)) continue
    out.push({
      capName: cap.capName,
      path,
      message: `\`${name}\` names a unit; name the quantity (power, temperature, level, signal ...). The unit is the D944 base of the quantity.`,
    })
  }
  return out
}

/** Allowance keys that no longer match a unit-looking field (stale entries rot). */
export function staleAllowances(
  caps: readonly FieldNameCap[],
  allowed: ReadonlyMap<string, string>,
): readonly string[] {
  const live = new Set<string>()
  for (const cap of caps) {
    if (cap.scope !== 'device') continue
    const paths: string[] = []
    if (cap.runtimeState !== undefined) collectPaths(cap.runtimeState, '', paths)
    paths.push(...historyPaths(cap.history))
    for (const path of paths) {
      if (looksLikeUnit(path.split('.').pop() ?? path)) live.add(`${cap.capName}.${path}`)
    }
  }
  return [...allowed.keys()].filter((key) => !live.has(key))
}

/** Parse the allowance file: `<cap>.<path> -- <reason>`, a reason is required. */
export function parseAllowances(text: string): {
  readonly allowed: ReadonlyMap<string, string>
  readonly errors: readonly string[]
} {
  const allowed = new Map<string, string>()
  const errors: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const split = line.indexOf(' -- ')
    const key = split === -1 ? line : line.slice(0, split).trim()
    const reason = split === -1 ? '' : line.slice(split + 4).trim()
    if (reason.length === 0) {
      errors.push(`allowance \`${key}\` has no reason (write \`${key} -- why it stays\`)`)
      continue
    }
    allowed.set(key, reason)
  }
  return { allowed, errors }
}
