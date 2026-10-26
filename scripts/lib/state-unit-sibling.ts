/**
 * D944 §4 — a device reading stores its unit on the declaration, not as a
 * sibling of the sample. Judgement is pure so a spec can build a fixture.
 */
import { z } from 'zod'
import type {
  CapabilityHistory,
  CapabilityHistoryField,
} from '../../packages/types/src/capabilities/capability-definition.js'
import {
  historyUnitFor,
  isReadingQuantity,
  type ReadingQuantity,
} from '../../packages/types/src/units/quantity.js'

export type StateUnitRule =
  | 'unit-sibling'
  | 'format-companion'
  | 'missing-quantity'
  | 'unit-from'
  | 'history-unit'
  | 'stale-debt'

export interface StateUnitViolation {
  readonly capName: string
  readonly path: string
  readonly rule: StateUnitRule
  readonly message: string
}

export interface StateUnitCap {
  readonly capName: string
  readonly scope: 'device' | 'system'
  readonly deviceNative: boolean
  readonly runtimeState: z.ZodType | undefined
  readonly history: CapabilityHistory | undefined
}

const FORMAT_CAPS: ReadonlySet<string> = new Set(['control', 'enum-sensor'])

function isBag(value: unknown): value is { readonly quantity?: unknown } {
  return typeof value === 'object' && value !== null
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

function quantityOn(schema: z.ZodType): ReadingQuantity | undefined {
  let current: z.ZodType | undefined = schema
  for (let guard = 0; guard < 16 && current !== undefined; guard += 1) {
    const bag: unknown = z.globalRegistry.get(current)
    if (isBag(bag) && isReadingQuantity(bag.quantity)) return bag.quantity
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodReadonly ||
      current instanceof z.ZodCatch
    ) {
      current = current.unwrap()
      continue
    }
    break
  }
  const inner = peel(schema)
  if (inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) {
    for (const option of inner.options) {
      if (option instanceof z.ZodType) {
        const found = quantityOn(option)
        if (found !== undefined) return found
      }
    }
  }
  return undefined
}

function isNumberSchema(schema: z.ZodType): boolean {
  const inner = peel(schema)
  if (inner instanceof z.ZodNumber) return true
  if (inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) {
    return inner.options.some((option) => option instanceof z.ZodType && isNumberSchema(option))
  }
  return false
}

function isClock(path: string): boolean {
  const name = path.split('.').pop() ?? path
  if (name === 'lastFetchedAt' || name === 'lastChangedAt' || name === 'lastResetAt') return true
  if (name.endsWith('At')) return true
  if (name === 'id' || name.endsWith('Id')) return true
  return false
}

function isSiblingName(name: string): boolean {
  return name === 'unit' || name === 'precision' || name.endsWith('Unit')
}

interface NumericField {
  readonly path: string
  readonly quantity: ReadingQuantity | undefined
}

function collect(
  schema: z.ZodType,
  prefix: string,
  fields: NumericField[],
  siblings: string[],
): void {
  const root = peel(schema)
  if (root instanceof z.ZodObject) {
    for (const [key, field] of Object.entries(root.shape)) {
      if (!(field instanceof z.ZodType)) continue
      const path = prefix.length > 0 ? `${prefix}.${key}` : key
      if (isSiblingName(key) || (key === 'format' && prefix.length === 0)) siblings.push(path)
      if (isNumberSchema(field) && !isClock(path) && !isSiblingName(key)) {
        fields.push({ path, quantity: quantityOn(field) })
      }
      collect(field, path, fields, siblings)
    }
    return
  }
  if (root instanceof z.ZodArray && root.element instanceof z.ZodType) {
    collect(root.element, prefix, fields, siblings)
  }
}

function historyFields(
  history: CapabilityHistory | undefined,
): ReadonlyMap<string, CapabilityHistoryField> {
  if (history === undefined || history === 'none') return new Map()
  const out = new Map<string, CapabilityHistoryField>()
  for (const [path, spec] of Object.entries(history.fields)) out.set(path, spec)
  for (const [path, spec] of Object.entries(history.items?.fields ?? {})) out.set(path, spec)
  return out
}

export function judgeStateUnits(
  cap: StateUnitCap,
  debt: ReadonlySet<string>,
): readonly StateUnitViolation[] {
  if (cap.scope !== 'device' || cap.runtimeState === undefined) return []
  const violations: StateUnitViolation[] = []
  const fields: NumericField[] = []
  const siblings: string[] = []
  collect(cap.runtimeState, '', fields, siblings)
  for (const path of siblings) {
    const name = path.split('.').pop() ?? path
    if (name === 'format') {
      if (!FORMAT_CAPS.has(cap.capName)) continue
      violations.push({
        capName: cap.capName,
        path,
        rule: 'format-companion',
        message: 'date/time format is a declaration, not a slice sibling',
      })
      continue
    }
    if (name === 'displayUnit') continue
    violations.push({
      capName: cap.capName,
      path,
      rule: 'unit-sibling',
      message: 'unit, precision and *Unit belong on the reading declaration (D944)',
    })
  }
  if (!cap.deviceNative) return violations
  const history = historyFields(cap.history)
  for (const field of fields) {
    const debtKey = `${cap.capName}.${field.path}`
    if (field.quantity === undefined) {
      if (debt.has(debtKey)) continue
      violations.push({
        capName: cap.capName,
        path: field.path,
        rule: 'missing-quantity',
        message: 'a numeric reading needs quantity meta, or quantity: "none"',
      })
      continue
    }
    if (debt.has(debtKey)) {
      violations.push({
        capName: cap.capName,
        path: field.path,
        rule: 'stale-debt',
        message: 'this field has a quantity; remove it from the debt list',
      })
    }
    const spec = history.get(field.path)
    if (spec === undefined) continue
    if (spec.unitFrom !== undefined) {
      violations.push({
        capName: cap.capName,
        path: field.path,
        rule: 'unit-from',
        message: 'history.unitFrom reads a sibling unit; use the quantity base',
      })
    }
    const expected = historyUnitFor(field.quantity)
    if (expected === undefined) {
      if (spec.unit !== undefined) {
        violations.push({
          capName: cap.capName,
          path: field.path,
          rule: 'history-unit',
          message: `quantity ${field.quantity} has no fixed history unit`,
        })
      }
      continue
    }
    if (spec.unit !== expected) {
      violations.push({
        capName: cap.capName,
        path: field.path,
        rule: 'history-unit',
        message: `history unit ${spec.unit ?? '(none)'} must be ${expected}`,
      })
    }
  }
  return violations
}

/** Paths of deviceNative numbers that still lack a quantity. */
export function unclassifiedQuantities(cap: StateUnitCap): readonly string[] {
  if (!cap.deviceNative || cap.scope !== 'device' || cap.runtimeState === undefined) return []
  const fields: NumericField[] = []
  collect(cap.runtimeState, '', fields, [])
  return fields
    .filter((field) => field.quantity === undefined)
    .map((field) => `${cap.capName}.${field.path}`)
}
