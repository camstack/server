/**
 * Shared reading and judging of a capability's `history` block (D850).
 *
 * Used by `generate-history-catalog.ts` (projection), `check-cap-history-
 * declared.ts` (the guard) and the guard's spec. The judgement is PURE — it
 * takes a plain description of one cap — so a spec can build a fixture cap from
 * a Zod schema without writing a `.cap.ts`.
 *
 * Why the real Zod schema and not the source text: "unwraps to number or
 * boolean" has to see through `.optional()`, `.nullable()`, `.default()`,
 * `.min().max()` and named const schemas imported from elsewhere. Text matching
 * missed the named-const shape once already (check-runtime-state-durability).
 */

import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { DeviceType } from '../../packages/types/src/device/device-type.js'
import {
  HISTORY_UNIT_LABELS,
  type CapabilityHistory,
  type CapabilityHistoryField,
  type CapabilityHistoryItems,
} from '../../packages/types/src/capabilities/capability-definition.js'
import { parseAllCaps } from './parse-cap.js'

type RuntimeStateSchema = z.ZodObject<z.core.$ZodLooseShape>

/** What the judgement needs to know about one cap. */
export interface HistoryCapView {
  readonly capName: string
  readonly runtimeState: RuntimeStateSchema | undefined
  readonly history: CapabilityHistory | undefined
  readonly volatileStateFields: readonly string[]
}

export type HistoryViolationRule =
  | 'missing-block'
  | 'block-without-runtime-state'
  | 'empty-fields'
  | 'unknown-field'
  | 'path-into-collection'
  | 'non-numeric-field'
  | 'kind-type-mismatch'
  | 'volatile-field'
  | 'unit-conflict'
  | 'unknown-unit'
  | 'unit-from-invalid'
  | 'boolean-numeric-option'
  | 'bad-option-value'
  | 'unknown-exclude-device-type'
  | 'enum-numeric-option'
  | 'enum-values-by-hand'
  | 'skip-when-set-invalid'
  | 'items-not-keyed-array'
  | 'items-key-invalid'

export interface HistoryViolation {
  readonly capName: string
  readonly rule: HistoryViolationRule
  readonly field?: string
  readonly message: string
}

/** Peel optional / nullable / default / readonly / catch wrappers. */
export function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema
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

type Resolution =
  | { readonly ok: true; readonly leaf: z.ZodType }
  | {
      readonly ok: false
      readonly rule: 'unknown-field' | 'path-into-collection'
      readonly why: string
    }

/** Walk a dotted path through fixed objects; refuse arrays, records and unions. */
export function resolveStatePath(root: RuntimeStateSchema, dotted: string): Resolution {
  let current: z.ZodType = root
  const segments = dotted.split('.')
  for (const [index, segment] of segments.entries()) {
    const parent = segments.slice(0, index).join('.') || 'runtimeState'
    const node = unwrapSchema(current)
    if (!(node instanceof z.ZodObject)) {
      return {
        ok: false,
        rule: 'path-into-collection',
        why: `\`${parent}\` is not a fixed object — a history path never enters an array, record, tuple or union`,
      }
    }
    const next: unknown = node.shape[segment]
    if (!(next instanceof z.ZodType)) {
      return {
        ok: false,
        rule: 'unknown-field',
        why: `\`${segment}\` is not a key of \`${parent}\``,
      }
    }
    current = next
  }
  return { ok: true, leaf: unwrapSchema(current) }
}

function isTextual(leaf: z.ZodType): boolean {
  return leaf instanceof z.ZodString || leaf instanceof z.ZodEnum
}

const KNOWN_DEVICE_TYPES: ReadonlySet<string> = new Set(Object.values(DeviceType))
const KNOWN_UNITS: ReadonlySet<string> = new Set(Object.keys(HISTORY_UNIT_LABELS))

function nonNegative(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value >= 0)
}

function judgeField(
  cap: HistoryCapView,
  runtimeState: RuntimeStateSchema,
  field: string,
  spec: CapabilityHistoryField,
): readonly HistoryViolation[] {
  const out: HistoryViolation[] = []
  const add = (rule: HistoryViolationRule, message: string): void => {
    out.push({ capName: cap.capName, rule, field, message })
  }

  const resolved = resolveStatePath(runtimeState, field)
  if (!resolved.ok) {
    add(resolved.rule, resolved.why)
  } else if (spec.kind === 'enum') {
    if (!isTextual(resolved.leaf)) {
      add(
        'kind-type-mismatch',
        "`kind: 'enum'` is a state: its schema must unwrap to a `z.enum` or a `z.string`",
      )
    }
  } else {
    const isNumber = resolved.leaf instanceof z.ZodNumber
    const isBoolean = resolved.leaf instanceof z.ZodBoolean
    if (!isNumber && !isBoolean) {
      add(
        'non-numeric-field',
        'its schema does not unwrap to a number or a boolean (text, enum, union, object and array state has no history)',
      )
    } else if (isBoolean && spec.kind !== 'boolean') {
      add(
        'kind-type-mismatch',
        `a boolean field must be \`kind: 'boolean'\`, found \`${spec.kind}\``,
      )
    } else if (isNumber && spec.kind === 'boolean') {
      add(
        'kind-type-mismatch',
        "`kind: 'boolean'` on a number field — a boolean series is a boolean field",
      )
    }
  }

  const root = field.split('.')[0] ?? field
  if (cap.volatileStateFields.includes(root) || cap.volatileStateFields.includes(field)) {
    add(
      'volatile-field',
      'it is a clock listed in `volatileStateFields`; a clock is not a measurement',
    )
  }

  if (spec.unit !== undefined && spec.unitFrom !== undefined) {
    add('unit-conflict', '`unit` and `unitFrom` are mutually exclusive')
  }
  if (spec.unit !== undefined && !KNOWN_UNITS.has(spec.unit)) {
    add('unknown-unit', `\`${spec.unit}\` is not a HistoryUnit`)
  }
  if (spec.unitFrom !== undefined) {
    const sibling = resolveStatePath(runtimeState, spec.unitFrom)
    if (!sibling.ok) {
      add('unit-from-invalid', `\`unitFrom: '${spec.unitFrom}'\` does not resolve — ${sibling.why}`)
    } else if (!isTextual(sibling.leaf)) {
      add('unit-from-invalid', `\`unitFrom: '${spec.unitFrom}'\` must be a string or enum field`)
    }
  }

  if (
    spec.kind === 'boolean' &&
    (spec.unit !== undefined ||
      spec.unitFrom !== undefined ||
      spec.deadband !== undefined ||
      spec.deadbandPct !== undefined)
  ) {
    add('boolean-numeric-option', 'a boolean series takes no unit, `unitFrom` or deadband')
  }
  if (
    spec.kind === 'enum' &&
    (spec.unit !== undefined ||
      spec.unitFrom !== undefined ||
      spec.deadband !== undefined ||
      spec.deadbandPct !== undefined)
  ) {
    add('enum-numeric-option', 'an enum series takes no unit, `unitFrom` or deadband')
  }
  if (spec.values !== undefined) {
    add(
      'enum-values-by-hand',
      '`values` is projected by codegen from the field’s `z.enum` — never written in a cap',
    )
  }
  if (spec.skipWhenSet !== undefined && !resolveStatePath(runtimeState, spec.skipWhenSet).ok) {
    add('skip-when-set-invalid', `\`skipWhenSet: '${spec.skipWhenSet}'\` names no field`)
  }
  if (
    !nonNegative(spec.deadband) ||
    !nonNegative(spec.minIntervalMs) ||
    (spec.deadbandPct !== undefined && !(spec.deadbandPct > 0 && spec.deadbandPct <= 100))
  ) {
    add(
      'bad-option-value',
      '`deadband` and `minIntervalMs` must be >= 0, `deadbandPct` in (0, 100]',
    )
  }

  for (const type of spec.excludeDeviceTypes ?? []) {
    if (!KNOWN_DEVICE_TYPES.has(type)) {
      add('unknown-exclude-device-type', `\`${type}\` is not a DeviceType`)
    }
  }
  return out
}

/**
 * The ITEM schema of a keyed array declared by `history.items` (D917): the
 * path must resolve through fixed objects to an array whose element is an
 * object. `null` for anything else.
 */
export function resolveItemSchema(
  root: RuntimeStateSchema,
  itemsPath: string,
): RuntimeStateSchema | null {
  const resolved = resolveStatePath(root, itemsPath)
  if (!resolved.ok || !(resolved.leaf instanceof z.ZodArray)) return null
  const element: unknown = resolved.leaf.element
  if (!(element instanceof z.ZodType)) return null
  const item = unwrapSchema(element)
  return item instanceof z.ZodObject ? item : null
}

/**
 * The values of a `z.enum` field in declaration order — what the catalog
 * carries as `values` for an `enum` series. `undefined` for any other leaf
 * (a `z.string` enum learns its values at capture time). With `itemsPath`,
 * `field` is relative to an item of that keyed array.
 */
export function enumValuesOf(
  root: RuntimeStateSchema,
  field: string,
  itemsPath?: string,
): readonly string[] | undefined {
  const base = itemsPath === undefined ? root : resolveItemSchema(root, itemsPath)
  if (base === null) return undefined
  const resolved = resolveStatePath(base, field)
  if (!resolved.ok || !(resolved.leaf instanceof z.ZodEnum)) return undefined
  return resolved.leaf.options.map((o) => String(o))
}

/** Judge one cap's `history` block. Empty array = clean. */
export function judgeCapHistory(cap: HistoryCapView): readonly HistoryViolation[] {
  const { capName, runtimeState, history } = cap
  if (runtimeState === undefined) {
    return history === undefined
      ? []
      : [
          {
            capName,
            rule: 'block-without-runtime-state',
            message: 'declares `history` but no `runtimeState` — there is nothing to record',
          },
        ]
  }
  if (history === undefined) {
    return [
      {
        capName,
        rule: 'missing-block',
        message:
          "declares `runtimeState` but no `history` — add `history: 'none'` or a `fields` block",
      },
    ]
  }
  if (history === 'none') return []
  const entries = Object.entries(history.fields)
  const itemEntries = Object.entries(history.items?.fields ?? {})
  if (entries.length === 0 && itemEntries.length === 0) {
    return [
      {
        capName,
        rule: 'empty-fields',
        message: "`history.fields` is empty — say `history: 'none'` instead",
      },
    ]
  }
  const top = entries.flatMap(([field, spec]) => judgeField(cap, runtimeState, field, spec))
  return history.items === undefined
    ? top
    : [...top, ...judgeItems(cap, runtimeState, history.items)]
}

/** A keyed array (D917): an array of objects, a string key (and label), item-relative fields. */
function judgeItems(
  cap: HistoryCapView,
  runtimeState: RuntimeStateSchema,
  items: CapabilityHistoryItems,
): readonly HistoryViolation[] {
  const item = resolveItemSchema(runtimeState, items.path)
  if (item === null) {
    return [
      {
        capName: cap.capName,
        rule: 'items-not-keyed-array',
        field: items.path,
        message: `\`items.path: '${items.path}'\` must resolve through fixed objects to an array of objects`,
      },
    ]
  }
  const out: HistoryViolation[] = []
  for (const [role, name] of [
    ['key', items.key],
    ['label', items.label],
  ] as const) {
    if (name === undefined) continue
    const resolved = resolveStatePath(item, name)
    if (!resolved.ok || !(resolved.leaf instanceof z.ZodString)) {
      out.push({
        capName: cap.capName,
        rule: 'items-key-invalid',
        field: `${items.path}[].${name}`,
        message: `the item ${role} \`${name}\` must be a string field of the item`,
      })
    }
  }
  // An item field is judged against the ITEM schema. `volatileStateFields` names
  // runtimeState roots, never item fields, so it does not apply inside an item.
  const itemView: HistoryCapView = { ...cap, volatileStateFields: [] }
  for (const [field, spec] of Object.entries(items.fields)) {
    out.push(
      ...judgeField(itemView, item, field, spec).map((v) => ({
        ...v,
        field: `${items.path}[].${field}`,
      })),
    )
  }
  return out
}

interface CapModuleShape {
  readonly runtimeState?: unknown
  readonly history?: CapabilityHistory
}

function isCapModuleShape(value: unknown): value is CapModuleShape {
  return value !== null && typeof value === 'object'
}

const CAPS_DIR = path.resolve(import.meta.dirname, '../../packages/types/src/capabilities')

/** Every cap that declares `runtimeState` or `history`, loaded from its module. */
export async function loadHistoryCaps(): Promise<readonly HistoryCapView[]> {
  const out: HistoryCapView[] = []
  for (const info of parseAllCaps(CAPS_DIR)) {
    const file = info.fileName.replace(/\.js$/, '.ts')
    const mod: Record<string, unknown> = await import(pathToFileURL(path.join(CAPS_DIR, file)).href)
    const def = mod[info.exportName]
    if (!isCapModuleShape(def)) continue
    const runtimeState = def.runtimeState instanceof z.ZodObject ? def.runtimeState : undefined
    if (runtimeState === undefined && def.history === undefined) continue
    out.push({
      capName: info.capName,
      runtimeState,
      history: def.history,
      volatileStateFields: info.volatileStateFields,
    })
  }
  return out.toSorted((a, b) => a.capName.localeCompare(b.capName))
}
