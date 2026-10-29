/**
 * The save boundary of the value + unit contract (D972).
 *
 * A number tied to a physical quantity is ENTERED in a unit the person picks
 * and STORED in a fixed one:
 *
 *  - a condition leaf on a device field → the field's base unit (D944);
 *  - a cap step arg → the unit the method's input declares (`paramMeta`).
 *
 * The write form of a number is {@link QuantityValue} (`{ value, unit }`,
 * "this number is in this unit"). Normalising converts it, stores the bare
 * number and records the picked unit (`leaf.unit` / `step.argUnits[arg]`) so an
 * editor can show the number the way it was typed. Normalising an already
 * normalised record changes nothing: a stored bare number is never converted
 * again, which is why the picked unit is a separate field.
 *
 * A bare number on a quantity field is ACCEPTED as the base / declared unit
 * and reported as a {@link UnitWarning}; a unit that cannot belong to the
 * quantity is a typed {@link QuantityUnitError}.
 *
 * Pure: the cap knowledge arrives as a {@link UnitResolver}.
 */
import type { CapabilityDefinition } from '../capabilities/capability-definition.js'
import {
  enumerateItemArrayFields,
  enumerateSchemaFields,
  unwrapSchema,
} from '../device/schema-fields.js'
import { normalizeUnit } from '../device/source-info.js'
import {
  type ParamMeta,
  QuantityUnitError,
  convertQuantityInput,
  isQuantityValue,
  paramMetaOf,
} from '../units/quantity-input.js'
import type { ReadingQuantity } from '../units/quantity.js'
import { baseUnitForQuantity, unitsForQuantity } from '../units/quantity-units.js'
import { z } from 'zod'
import type {
  AutomationAction,
  AutomationCapStep,
  AutomationCondition,
  AutomationRecipe,
} from './recipe.js'

/** What the boundary needs to know about caps. */
export interface UnitResolver {
  /** The quantity of a status field, or `undefined` when it is not a quantity. */
  fieldQuantity(cap: string, fieldPath: string): ReadingQuantity | undefined
  /** What a method input declares for `arg`, or `undefined` when it is not a quantity. */
  paramMeta(cap: string, method: string, arg: string): ParamMeta | undefined
}

/** A bare number accepted as a base unit — the save succeeded, say so. */
export const UnitWarningSchema = z.object({
  /** Where in the saved record, e.g. `conditions.children.0` or `steps.2.args.grams`. */
  path: z.string(),
  deviceId: z.number().int().optional(),
  field: z.string(),
  value: z.number(),
  assumedUnit: z.string(),
  message: z.string(),
})
export type UnitWarning = z.infer<typeof UnitWarningSchema>

export interface UnitsNormalized<T> {
  readonly value: T
  readonly warnings: readonly UnitWarning[]
}

function objectInput(schema: z.ZodType): z.ZodObject | undefined {
  const inner = unwrapSchema(schema)
  return inner instanceof z.ZodObject ? inner : undefined
}

/** A resolver over capability definitions (the generated registry, or a fake). */
export function capUnitResolver(defs: readonly CapabilityDefinition[]): UnitResolver {
  const byName = new Map(defs.map((def) => [def.name, def]))
  return {
    fieldQuantity(cap, fieldPath) {
      const status = byName.get(cap)?.status
      if (status === undefined) return undefined
      const fields = [
        ...enumerateSchemaFields(status.schema),
        ...(status.itemArray === undefined ? [] : enumerateItemArrayFields(status.itemArray)),
      ]
      return fields.find((f) => f.path === fieldPath)?.quantity
    },
    paramMeta(cap, method, arg) {
      const input = byName.get(cap)?.methods[method]?.input
      if (input === undefined) return undefined
      const field: z.ZodType | undefined = objectInput(input)?.shape[arg]
      return field === undefined ? undefined : paramMetaOf(field)
    },
  }
}

function pickedUnit(raw: string): string {
  return normalizeUnit(raw) ?? raw
}

function hasUnitChoice(quantity: ReadingQuantity): boolean {
  return unitsForQuantity(quantity).length > 1
}

function bareWarning(input: {
  readonly path: string
  readonly deviceId?: number
  readonly field: string
  readonly value: number
  readonly assumedUnit: string
}): UnitWarning {
  return {
    ...input,
    message: `${input.field}: the bare number ${input.value} was taken as ${input.assumedUnit} — send { value, unit } to state the unit`,
  }
}

function checkPickedUnit(unit: string, target: string): void {
  convertQuantityInput({ value: 1, unit, target })
}

interface LeafOutcome {
  readonly leaf: AutomationConditionLeafLike
  readonly warnings: readonly UnitWarning[]
}
type AutomationConditionLeafLike = Extract<AutomationCondition, { kind: 'condition' }>

function normalizeLeaf(
  leaf: AutomationConditionLeafLike,
  resolver: UnitResolver,
  path: string,
): LeafOutcome {
  const quantity = resolver.fieldQuantity(leaf.cap, leaf.fieldPath)
  const base = quantity === undefined ? undefined : baseUnitForQuantity(quantity)
  const wantsUnit = isQuantityValue(leaf.value) || leaf.unit !== undefined
  if (base === undefined || quantity === undefined) {
    if (wantsUnit) {
      throw new QuantityUnitError(
        'no-quantity',
        `${leaf.cap}.${leaf.fieldPath} is not a quantity — it takes no unit`,
      )
    }
    return { leaf, warnings: [] }
  }
  if (isQuantityValue(leaf.value)) {
    const converted = convertQuantityInput({
      value: leaf.value.value,
      unit: leaf.value.unit,
      target: base,
    })
    return {
      leaf: { ...leaf, value: converted, unit: pickedUnit(leaf.value.unit) },
      warnings: [],
    }
  }
  if (typeof leaf.value !== 'number') return { leaf, warnings: [] }
  if (leaf.unit !== undefined) {
    checkPickedUnit(leaf.unit, base)
    return { leaf, warnings: [] }
  }
  if (!hasUnitChoice(quantity)) return { leaf, warnings: [] }
  return {
    leaf,
    warnings: [
      bareWarning({
        path,
        deviceId: leaf.deviceId,
        field: leaf.fieldPath,
        value: leaf.value,
        assumedUnit: base,
      }),
    ],
  }
}

/** Normalise every leaf of a condition tree. Throws {@link QuantityUnitError}. */
export function normalizeConditionUnits(
  condition: AutomationCondition,
  resolver: UnitResolver,
  path = 'conditions',
): UnitsNormalized<AutomationCondition> {
  switch (condition.kind) {
    case 'condition': {
      const { leaf, warnings } = normalizeLeaf(condition, resolver, path)
      return { value: leaf, warnings }
    }
    case 'not': {
      const inner = normalizeConditionUnits(condition.child, resolver, `${path}.child`)
      return { value: { ...condition, child: inner.value }, warnings: inner.warnings }
    }
    case 'all':
    case 'any': {
      const children = condition.children.map((child, i) =>
        normalizeConditionUnits(child, resolver, `${path}.children.${i}`),
      )
      return {
        value: { ...condition, children: children.map((c) => c.value) },
        warnings: children.flatMap((c) => c.warnings),
      }
    }
    default:
      return { value: condition, warnings: [] }
  }
}

function normalizeCapStep(
  step: AutomationCapStep,
  resolver: UnitResolver,
  path: string,
): UnitsNormalized<AutomationCapStep> {
  const deviceId = typeof step.deviceId === 'number' ? step.deviceId : undefined
  const args: Record<string, unknown> = { ...step.args }
  const argUnits: Record<string, string> = { ...step.argUnits }
  const warnings: UnitWarning[] = []
  for (const [arg, picked] of Object.entries(step.argUnits ?? {})) {
    const meta = resolver.paramMeta(step.cap, step.method, arg)
    if (meta === undefined) {
      throw new QuantityUnitError(
        'no-quantity',
        `${step.cap}.${step.method}(${arg}) is not a quantity — it takes no unit`,
      )
    }
    checkPickedUnit(picked, meta.unit)
  }
  for (const [arg, given] of Object.entries(step.args ?? {})) {
    const meta = resolver.paramMeta(step.cap, step.method, arg)
    if (meta === undefined) continue
    if (isQuantityValue(given)) {
      args[arg] = convertQuantityInput({ value: given.value, unit: given.unit, target: meta.unit })
      argUnits[arg] = pickedUnit(given.unit)
    } else if (
      typeof given === 'number' &&
      argUnits[arg] === undefined &&
      hasUnitChoice(meta.quantity)
    ) {
      warnings.push(
        bareWarning({
          path: `${path}.args.${arg}`,
          ...(deviceId === undefined ? {} : { deviceId }),
          field: arg,
          value: given,
          assumedUnit: meta.unit,
        }),
      )
    }
  }
  const { argUnits: _dropped, ...rest } = step
  return {
    value: {
      ...rest,
      ...(step.args === undefined ? {} : { args }),
      ...(Object.keys(argUnits).length > 0 ? { argUnits } : {}),
    },
    warnings,
  }
}

/**
 * Normalise the cap steps of an action list (an internal Action's steps, or a
 * recipe's actions). Other step kinds pass through. Throws {@link QuantityUnitError}.
 */
export function normalizeActionUnits<A extends AutomationAction>(
  actions: readonly A[],
  resolver: UnitResolver,
  path = 'steps',
): UnitsNormalized<(A | AutomationCapStep)[]> {
  const out: (A | AutomationCapStep)[] = []
  const warnings: UnitWarning[] = []
  actions.forEach((action, i) => {
    if (action.kind !== 'cap') {
      out.push(action)
      return
    }
    const normalized = normalizeCapStep(action, resolver, `${path}.${i}`)
    out.push(normalized.value)
    warnings.push(...normalized.warnings)
  })
  return { value: out, warnings }
}

/** Normalise a whole recipe: its condition tree and its actions. */
export function normalizeRecipeUnits(
  recipe: AutomationRecipe,
  resolver: UnitResolver,
): UnitsNormalized<AutomationRecipe> {
  const conditions =
    recipe.conditions === undefined
      ? undefined
      : normalizeConditionUnits(recipe.conditions, resolver, 'conditions')
  const actions = normalizeActionUnits(recipe.actions, resolver, 'actions')
  return {
    value: {
      ...recipe,
      ...(conditions === undefined ? {} : { conditions: conditions.value }),
      actions: actions.value,
    },
    warnings: [...(conditions?.warnings ?? []), ...actions.warnings],
  }
}
