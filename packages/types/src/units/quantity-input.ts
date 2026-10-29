/**
 * A number a person types for a physical quantity — the input side of the
 * value + unit contract (D972).
 *
 * Readings are stored in the base unit of their quantity (D944); a cap method
 * param is stored in the unit its input schema DECLARES (`paramMeta`). The
 * wire pair {@link QuantityValue} says "this number is expressed in this
 * unit"; {@link convertQuantityInput} brings it to the stored unit and refuses,
 * with a typed {@link QuantityUnitError}, a unit that cannot be that quantity.
 */
import { z } from 'zod'
import { unwrapSchema } from '../device/schema-fields.js'
import { normalizeUnit } from '../device/source-info.js'
import { tryConvertUnit, unitDimension } from './convert.js'
import { type ReadingQuantity, ReadingQuantitySchema, baseUnitOf } from './quantity.js'

export type QuantityUnitErrorCode =
  | 'non-finite'
  | 'unknown-unit'
  | 'cross-dimension'
  /** A unit was given for a field or param that is not a quantity. */
  | 'no-quantity'

/** A unit that cannot be applied to the number it was given with. */
export class QuantityUnitError extends Error {
  readonly code: QuantityUnitErrorCode
  constructor(code: QuantityUnitErrorCode, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'QuantityUnitError'
    this.code = code
  }
}

/** The wire pair: `value` is expressed in `unit`. */
export const QuantityValueSchema = z.object({
  value: z.number(),
  unit: z.string().min(1),
})
export type QuantityValue = z.infer<typeof QuantityValueSchema>

export function isQuantityValue(candidate: unknown): candidate is QuantityValue {
  return QuantityValueSchema.safeParse(candidate).success
}

export interface ConvertQuantityInput {
  readonly value: number
  /** The unit `value` is expressed in, as the person picked it. */
  readonly unit: string
  /** The unit to store: the quantity base, or a param's declared unit. */
  readonly target: string
}

/**
 * `value` expressed in `unit`, brought to `target`. Throws
 * {@link QuantityUnitError} for a non-finite value, an unknown unit or a unit
 * of another dimension — never guesses.
 */
export function convertQuantityInput(input: ConvertQuantityInput): number {
  if (!Number.isFinite(input.value)) {
    throw new QuantityUnitError('non-finite', `${String(input.value)} is not a finite number`)
  }
  const unit = normalizeUnit(input.unit)
  if (unit === undefined || unitDimension(unit) === undefined) {
    throw new QuantityUnitError('unknown-unit', `unknown unit "${input.unit}"`)
  }
  const converted = tryConvertUnit(input.value, unit, input.target)
  if (converted === undefined) {
    throw new QuantityUnitError(
      'cross-dimension',
      `"${input.unit}" is not a unit of ${input.target}'s quantity`,
    )
  }
  // 0.1 kg → 100.00000000000001 g would fail an integer param; 12 digits is far
  // finer than any instrument and keeps the stored number what the person typed.
  return Number(converted.toPrecision(12))
}

/** What a method input field declares: the quantity and the unit its value is in. */
export interface ParamMeta {
  readonly [key: string]: unknown
  readonly quantity: ReadingQuantity
  readonly unit: string
}

/**
 * Zod `.meta()` bag for a cap METHOD param that is a physical quantity — the
 * input-side twin of `readingMeta`. The value is carried in `unit` (a gram
 * portion stays in grams); the unit must belong to the quantity, checked once
 * when the cap is declared.
 */
export function paramMeta(declared: {
  readonly quantity: ReadingQuantity
  readonly unit: string
}): ParamMeta {
  const base = baseUnitOf(declared.quantity)
  if (base === undefined) {
    throw new QuantityUnitError('unknown-unit', `quantity "${declared.quantity}" has no unit`)
  }
  if (tryConvertUnit(1, declared.unit, base) === undefined) {
    throw new QuantityUnitError(
      'cross-dimension',
      `"${declared.unit}" is not a unit of ${declared.quantity}`,
    )
  }
  return { quantity: declared.quantity, unit: declared.unit }
}

const ParamMetaBagSchema = z.object({ quantity: ReadingQuantitySchema, unit: z.string().min(1) })

function metaOf(schema: z.ZodType): ParamMeta | undefined {
  const parsed = ParamMetaBagSchema.safeParse(z.globalRegistry.get(schema))
  return parsed.success ? parsed.data : undefined
}

/** The `paramMeta` on a method input field (or its unwrapped leaf), if any. */
export function paramMetaOf(field: z.ZodType): ParamMeta | undefined {
  return metaOf(field) ?? metaOf(unwrapSchema(field))
}
