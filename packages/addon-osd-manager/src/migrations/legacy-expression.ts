/**
 * The pre-template OSD vocabulary (`displayUnit`, `maxDecimals`, `valueMap`,
 * `{alias.value}` tokens, the `${value}` wrapper, the clock and recognition
 * sources) written as device-template text (D1021/D1025).
 *
 * Frozen on purpose: a migration states the shape it READS, so these schemas
 * never follow the live ones.
 */
import { normalizeUnit, runtimeFieldUnit, templateCapKey } from '@camstack/types'
import { z } from 'zod'

export const LegacySourceSchema = z.object({ kind: z.string() }).passthrough()

export const LegacySlotBindingSchema = z
  .object({
    enabled: z.boolean().default(true),
    source: LegacySourceSchema,
    template: z.string().optional(),
    maxDecimals: z.number().int().optional(),
    valueMap: z.record(z.string(), z.string()).optional(),
    schedule: z.unknown().optional(),
    conditions: z.unknown().optional(),
  })
  .passthrough()
export type LegacySlotBinding = z.infer<typeof LegacySlotBindingSchema>

export const LegacyDeviceStateSourceSchema = z.object({
  kind: z.literal('device-state'),
  deviceId: z.number().int().optional(),
  capName: z.string(),
  valuePath: z.string(),
  displayUnit: z.string().optional(),
})
export const LegacyClockSourceSchema = z.object({
  kind: z.literal('clock'),
  pattern: z.string().default('HH:mm'),
  timezone: z.string().optional(),
})
export const LegacyRecognitionSourceSchema = z.object({
  kind: z.literal('latest-recognition'),
  recognition: z.enum(['person', 'plate']),
})
export const LegacyTemplateSourceSchema = z.object({
  kind: z.literal('template'),
  templateId: z.string(),
})
export const LegacyStaticSourceSchema = z.object({ kind: z.literal('static'), text: z.string() })

export const LegacyTemplateBindingSchema = z.object({
  alias: z.string(),
  pick: z.object({ deviceId: z.number().int() }).passthrough(),
  capName: z.string(),
  valuePath: z.string(),
  displayUnit: z.string().optional(),
  maxDecimals: z.number().int().default(1),
  valueMap: z.record(z.string(), z.string()).optional(),
})
export type LegacyTemplateBinding = z.infer<typeof LegacyTemplateBindingSchema>

export const LegacyNamedTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    bindings: z.array(LegacyTemplateBindingSchema).default([]),
    parser: z.string().default(''),
  })
  .passthrough()
export type LegacyNamedTemplate = z.infer<typeof LegacyNamedTemplateSchema>

export interface ExpressionSpec {
  /** The template reference, e.g. `camera.motion.detected`. */
  readonly ref: string
  readonly displayUnit: string | undefined
  readonly maxDecimals: number
  readonly valueMap: Readonly<Record<string, string>> | undefined
  /** The field's D944 base unit from the capability schema (`runtimeFieldUnit`); `undefined` = none. */
  readonly baseUnit: string | undefined
}

/** The base unit a capability field declares, the same table the editor and `unit()` read. */
export function baseUnitOf(capName: string, valuePath: string): string | undefined {
  return runtimeFieldUnit(capName, valuePath)
}

/** The two halves the old tokens named: what `${value}` / `{a.value}` and `${unit}` / `{a.unit}` print. */
export interface ExpressionParts {
  readonly value: string
  readonly unit: string
}

/** Keep operator text literal: `{{`, `{%` and `{#` would open template syntax. */
export function escapeLiteral(text: string): string {
  return text.replace(/\{(?=[{%#])/g, "{{ '{' }}")
}

function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** The reference path of a device field: `<alias>.<cap_key>.<path>`. */
export function fieldRef(alias: string, capName: string, valuePath: string): string {
  return `${alias}.${templateCapKey(capName)}.${valuePath}`
}

/**
 * Whether the value is the one an old `valueMap` key named. The old map keyed on `String(raw)`, so the
 * test is STRICT (`sameas`): the engine's `==` is JavaScript's loose one, where `1 == true`.
 */
function matchesKey(ref: string, key: string): string {
  if (key === 'true' || key === 'false')
    return `(${ref} is sameas(${key}) or ${ref} is sameas('${key}'))`
  if (/^-?\d+(\.\d+)?$/.test(key))
    return `((${ref} is number and ${ref} == ${key}) or ${ref} is sameas('${key}'))`
  return `${ref} is sameas(${quote(key)})`
}

/** Unit the old code printed: the display unit, else the one the field is published in. */
function unitOf(spec: ExpressionSpec): { convertTo: string | undefined; shown: string } {
  const to = spec.displayUnit === undefined ? undefined : normalizeUnit(spec.displayUnit)
  const from = spec.baseUnit === undefined ? undefined : normalizeUnit(spec.baseUnit)
  return { convertTo: to, shown: to ?? from ?? '' }
}

/**
 * The text a state value prints when no `valueMap` entry claims it. One shape for every value kind,
 * chosen from nothing the device is doing right now: `onoff` turns a boolean into ON/OFF, `trunc` cuts a
 * number to the decimals toward zero (the old formatter never rounded: 19.99 at one decimal printed 19.9)
 * and both hand a string back as it is. An offline device migrates the same as an online one.
 */
function plainValue(spec: ExpressionSpec, convertTo: string | undefined): string {
  const digits = Math.min(Math.max(spec.maxDecimals, 0), 12)
  if (convertTo === undefined) return `{{ ${spec.ref} | onoff | trunc(${digits}) }}`
  const symbol = escapeLiteral(convertTo)
  // `unit` must come first (the engine hands it the field's base unit there). `format('%s')` hands back text, so the unit symbol the engine appends (with a
  // space) can be cut and the old, tight `21.5°C` reproduced.
  return `{{ ${spec.ref} | unit(${quote(convertTo)}) | onoff | trunc(${digits}) | format('%s') | replace(${quote(` ${symbol}`)}, '') }}`
}

export function expressionParts(spec: ExpressionSpec): ExpressionParts {
  const { convertTo, shown } = unitOf(spec)
  const plain = plainValue(spec, convertTo)
  const entries = Object.entries(spec.valueMap ?? {})
  const unitLiteral = escapeLiteral(shown)
  if (entries.length === 0) return { value: plain, unit: unitLiteral }

  const branches = entries.map(
    ([key, mapped], i) =>
      `{% ${i === 0 ? 'if' : 'elif'} ${matchesKey(spec.ref, key)} %}${escapeLiteral(mapped)}`,
  )
  const value = `${branches.join('')}{% else %}${plain}{% endif %}`
  // A mapped value hides its unit, exactly as the old code did.
  const claimed = entries.map(([key]) => matchesKey(spec.ref, key)).join(' or ')
  const unit = unitLiteral === '' ? '' : `{% if ${claimed} %}{% else %}${unitLiteral}{% endif %}`
  return { value, unit }
}

/** `${value}` and `${unit}` replaced in an operator's wrapper; the rest stays literal. */
export function foldWrapper(wrapper: string, parts: ExpressionParts): string {
  return wrapper
    .split(/(\$\{value\}|\$\{unit\})/)
    .map((piece) => {
      if (piece === '${value}') return parts.value
      if (piece === '${unit}') return parts.unit
      return escapeLiteral(piece)
    })
    .join('')
}

export function clockExpression(pattern: string): string {
  return `{{ now | time(${quote(pattern)}) }}`
}

export function recognitionExpression(kind: 'person' | 'plate'): string {
  return kind === 'person' ? '{{ camera.lastPerson }}' : '{{ camera.lastPlate }}'
}

/** Which old tokens a parser carries, in order: `{a}`, `{a.value}`, `{a.unit}`, `{a.full}`. */
export function convertParser(
  parser: string,
  partsOf: (alias: string) => ExpressionParts | undefined,
): string {
  const token = /\{([A-Za-z][A-Za-z0-9_-]*)(?:\.(value|unit|full))?\}/g
  let out = ''
  let last = 0
  for (const match of parser.matchAll(token)) {
    const alias = match[1]
    const parts = alias === undefined ? undefined : partsOf(alias)
    if (parts === undefined) continue
    out += escapeLiteral(parser.slice(last, match.index))
    const kind = match[2] ?? 'full'
    out +=
      kind === 'value' ? parts.value : kind === 'unit' ? parts.unit : `${parts.value}${parts.unit}`
    last = (match.index ?? 0) + match[0].length
  }
  return out + escapeLiteral(parser.slice(last))
}
