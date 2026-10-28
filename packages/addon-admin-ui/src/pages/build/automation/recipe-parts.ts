/**
 * The WHEN and THEN halves — constructors, list edits, and the one derivation
 * that must never become a hand-maintained catalog.
 *
 * `deviceManager.getWireableFields` already reports what KIND every device field
 * is, and {@link operatorsForFieldKind} is the only place that turns a kind into
 * the comparisons an operator may pick. A hard-coded per-cap list is how a
 * `>` appears next to a boolean, and how a field a provider added last week ends
 * up uncomparable — so the kinds, and the shape of the reply they come in, are
 * `z.infer`red off the capability itself. If the cap grows a fifth kind this
 * file stops compiling, which is the intended outcome.
 */

import type {
  AutomationAction,
  AutomationCondition,
  AutomationConditionOperator,
  AutomationRecipe,
  AutomationTrigger,
  deviceManagerCapability,
} from '@camstack/types'
import type { z } from 'zod'
import i18n from '../../../i18n/index'

type WireableFieldsOutput = z.infer<typeof deviceManagerCapability.methods.getWireableFields.output>

/** One capability's wireable fields, as the cap reports them. */
export type WireableCap = WireableFieldsOutput['caps'][number]
export type WireableField = WireableCap['fields'][number]
export type WireableFieldKind = WireableField['kind']

export type TriggerKind = AutomationTrigger['kind']
export type ActionKind = AutomationAction['kind']

const ALL_OPERATORS: readonly AutomationConditionOperator[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
]

/**
 * Which comparisons make sense for a field of this kind.
 *
 * `undefined` — the field's kind is not known yet, because the device's fields
 * have not loaded or the recipe names a field that no longer exists — returns
 * everything. Narrowing on a guess would silently drop the operator the recipe
 * was ALREADY saved with, and re-saving would then rewrite it to something the
 * operator never chose.
 */
export function operatorsForFieldKind(
  kind: WireableFieldKind | undefined,
): readonly AutomationConditionOperator[] {
  switch (kind) {
    case 'boolean':
      return ['eq', 'ne']
    case 'number':
      return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte']
    case 'string':
    case 'enum':
      return ['eq', 'ne', 'contains', 'in']
    default:
      return ALL_OPERATORS
  }
}

/** How each operator reads in a sentence. The row is written left to right. */
export function operatorLabel(operator: AutomationConditionOperator): string {
  switch (operator) {
    case 'eq':
      return i18n.t('helpers.recipeParts.op_eq')
    case 'ne':
      return i18n.t('helpers.recipeParts.op_ne')
    case 'gt':
      return i18n.t('helpers.recipeParts.op_gt')
    case 'gte':
      return i18n.t('helpers.recipeParts.op_gte')
    case 'lt':
      return i18n.t('helpers.recipeParts.op_lt')
    case 'lte':
      return i18n.t('helpers.recipeParts.op_lte')
    case 'contains':
      return i18n.t('helpers.recipeParts.op_contains')
    default:
      return i18n.t('helpers.recipeParts.op_in')
  }
}

export interface OperatorChoice {
  readonly value: AutomationConditionOperator
  readonly label: string
}

/** The comparison list a select renders — the derivation and its wording in one
 *  place, so a new operator can never appear with no label. */
export function operatorChoices(kind: WireableFieldKind | undefined): readonly OperatorChoice[] {
  return operatorsForFieldKind(kind).map((value) => ({ value, label: operatorLabel(value) }))
}

export function triggerKindLabel(kind: TriggerKind): string {
  switch (kind) {
    case 'device-state':
      return i18n.t('helpers.recipeParts.trigger_device_state')
    case 'device-event':
      return i18n.t('helpers.recipeParts.trigger_device_event')
    case 'schedule':
      return i18n.t('helpers.recipeParts.trigger_schedule')
    case 'stationary':
      return i18n.t('automation.readOnly.stationaryTrigger')
    case 'detection':
    case 'interval':
      return i18n.t('automation.readOnly.otherTrigger')
    default:
      return i18n.t('helpers.recipeParts.trigger_manual')
  }
}

/** A brand-new automation. Deliberately empty in both halves: a pre-seeded
 *  trigger pointing at device 0 is a decision the operator did not make, and
 *  `validateRecipeBounds` says exactly what is missing until they do. */
export const EMPTY_RECIPE: AutomationRecipe = { triggers: [], actions: [] }

export function newTrigger(kind: TriggerKind): AutomationTrigger {
  switch (kind) {
    case 'device-state':
      return { kind, deviceId: 0, cap: '', fieldPath: '' }
    case 'device-event':
      return { kind, category: '' }
    case 'schedule':
      return { kind, cron: '0 30 23 * * *' }
    default:
      return { kind: 'manual' }
  }
}

export function newAction(kind: ActionKind): AutomationAction {
  switch (kind) {
    case 'wait':
      return { kind, seconds: 5 }
    case 'code':
      return { kind, code: '// runs inside this automation, with ctx in scope\n' }
    case 'action':
      return { kind, actionId: '' }
    default:
      return { kind: 'cap', deviceId: 0, cap: '', method: '' }
  }
}

/** A fresh catalog leaf. `eq` because it is the only comparison every kind
 *  supports — whichever field is picked next, the row stays legal. */
export function newConditionLeaf(): AutomationCondition {
  return { kind: 'condition', deviceId: 0, cap: '', fieldPath: '', operator: 'eq', value: '' }
}

export function newExpressionLeaf(): AutomationCondition {
  return { kind: 'expression', expr: '', bindings: {} }
}

// ── immutable list edits ────────────────────────────────────────────────────

export function replaceAt<T>(items: readonly T[], index: number, next: T): readonly T[] {
  return items.map((item, i) => (i === index ? next : item))
}

export function removeAt<T>(items: readonly T[], index: number): readonly T[] {
  return items.filter((_, i) => i !== index)
}

/** Move an item, clamped. A drag that overshoots the list end should park the
 *  step last, not throw the edit away. */
export function moveItem<T>(items: readonly T[], from: number, to: number): readonly T[] {
  const item = items[from]
  if (item === undefined) return items
  const target = Math.min(Math.max(to, 0), items.length - 1)
  if (target === from) return items
  const without = removeAt(items, from)
  return [...without.slice(0, target), item, ...without.slice(target)]
}

/**
 * The two list slots, copied on the way in.
 *
 * `AutomationRecipe` is `z.infer`red, so its arrays are mutable while every
 * edit here produces a `readonly` one. The copy is what keeps both true — and it
 * is a fresh array either way, which is the point: the caller holds the previous
 * recipe as React state and re-renders from it.
 */
export function withTriggers(
  recipe: AutomationRecipe,
  triggers: readonly AutomationTrigger[],
): AutomationRecipe {
  return { ...recipe, triggers: [...triggers] }
}

export function withActions(
  recipe: AutomationRecipe,
  actions: readonly AutomationAction[],
): AutomationRecipe {
  return { ...recipe, actions: [...actions] }
}
