/**
 * Self-only invert / unit-convert composition features (D663, D939).
 * An override row writes the convert; a formula over the device's own
 * field replaces the old script. Invert stays available as a formula.
 */
import { SOURCE_CAP_ACTIVE_FIELD, SOURCE_CAPS } from '../../catalogs/sensor-active-state.js'
import { canConvertUnit } from '../../units/convert.js'
import type {
  CompositionExpressionSource,
  CompositionFieldsFeature,
  CompositionSourceRef,
} from '../composition.js'

/** Source caps whose active boolean may be inverted: catalogue minus switch
 *  (commands) and motion (event stream, D672). */
export const INVERTIBLE_CAPS: readonly string[] = SOURCE_CAPS.filter(
  (cap) => cap !== 'switch' && cap !== 'motion',
)

export interface InvertPresetInput {
  readonly self: CompositionSourceRef
  readonly cap: string
}

export function invertPresetFeature(input: InvertPresetInput): CompositionFieldsFeature | null {
  const field = SOURCE_CAP_ACTIVE_FIELD[input.cap]
  if (field === undefined || !INVERTIBLE_CAPS.includes(input.cap)) return null
  const source: CompositionExpressionSource = {
    kind: 'expression',
    expr: '!v',
    bindings: {
      v: { kind: 'from', source: input.self, cap: input.cap, fieldPath: field },
    },
  }
  return { kind: 'fields', cap: input.cap, fields: { [field]: source } }
}

export interface ConvertPresetInput {
  readonly self: CompositionSourceRef
  readonly cap: string
  readonly fieldPath: string
  readonly from: string
  readonly to: string
  /** Cap top-level `unit` field replaced with `to`; null when the cap has none. */
  readonly unitField: string | null
}

function unitConstant(to: string): CompositionExpressionSource {
  return { kind: 'expression', expr: JSON.stringify(to), bindings: {} }
}

/** Primary numeric field that also publishes the cap's `unit` string. */
const UNIT_COMPANION_FIELD: Readonly<Record<string, string>> = {
  'numeric-sensor': 'value',
  'temperature-sensor': 'celsius',
  'humidity-sensor': 'percent',
  'pressure-sensor': 'hpa',
  'ambient-light-sensor': 'lux',
}

/** `unit` when converting that cap's primary numeric field; otherwise none. */
export function unitCompanionField(cap: string, fieldPath: string): string | null {
  return UNIT_COMPANION_FIELD[cap] === fieldPath ? 'unit' : null
}

export function convertPresetFeature(input: ConvertPresetInput): CompositionFieldsFeature | null {
  if (input.from === input.to || !canConvertUnit(input.from, input.to)) return null
  const value: CompositionExpressionSource = {
    kind: 'expression',
    expr: `convert(v, ${JSON.stringify(input.from)}, ${JSON.stringify(input.to)})`,
    bindings: {
      v: {
        kind: 'from',
        source: input.self,
        cap: input.cap,
        fieldPath: input.fieldPath,
      },
    },
  }
  return {
    kind: 'fields',
    cap: input.cap,
    fields: {
      [input.fieldPath]: value,
      ...(input.unitField === null ? {} : { [input.unitField]: unitConstant(input.to) }),
    },
  }
}
