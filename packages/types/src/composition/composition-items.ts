/**
 * Item-array fields of a composition (D663): `consumables.items[<key>]`.
 *
 * Items are addressed through the cap's `status.itemArray` descriptor — the
 * one the source picker already uses — so a cap without one is refused
 * (`not-item-array`). A composition that names `items` owns the WHOLE array.
 * Each item leaf is planned as its own field, carrying `item`, and keyed by
 * `compositionFieldKey` so two items sharing an inner path never share a
 * record or a graph node.
 *
 * The composer sets some item fields itself: the key and label (from the
 * entry) and {@link COMPOSED_ITEM_FIXED_FIELDS}. A source for any of them is
 * refused by name (`item-field-reserved`) — `resettable` is fixed `false`
 * because `reset` is refused until commands arrive (slice 3).
 */
import type {
  CapabilityDefinition,
  CapabilityStatusItemArray,
} from '../capabilities/capability-definition.js'
import {
  COMPOSITION_ITEM_ARRAY_PATH,
  type CompositionFieldSource,
  type CompositionFieldsFeature,
  type CompositionItemEntry,
  fieldReads,
} from './composition.js'
import type {
  CompositionFeatureMode,
  CompositionFieldPlan,
  CompositionProblem,
} from './composition-report.js'
import { enumerateSchemaFields } from '../device/schema-fields.js'
import { describeStateField, optionalAncestors } from './state-fields.js'
import { type CompositionPlanResult, problem, refused } from './plan-result.js'
import {
  compatibility,
  enumLiteralProblem,
  roleOf,
  sourceKinds,
  unavailableFor,
} from './field-kinds.js'
import type { CapabilityLookup } from './validate-composition.js'

/** Item fields the composer writes itself, with the value it writes. */
export const COMPOSED_ITEM_FIXED_FIELDS = { resettable: false } as const

type ItemArray = CapabilityStatusItemArray

function reservedItemFields(itemArray: ItemArray): ReadonlySet<string> {
  return new Set([
    itemArray.keyField,
    ...(itemArray.labelField === undefined ? [] : [itemArray.labelField]),
    ...Object.keys(COMPOSED_ITEM_FIXED_FIELDS),
  ])
}

/** A required leaf under an optional parent is required only once something writes that parent. */
function leafRequired(itemArray: ItemArray, path: string, written: readonly string[]): boolean {
  const described = describeStateField(itemArray.itemSchema, path)
  if (described === null || !described.required) return false
  return optionalAncestors(itemArray.itemSchema, path).every((parent) =>
    written.some((w) => w.startsWith(`${parent}.`)),
  )
}

/** What every item of one feature is planned against — the reserved set is computed once. */
interface ItemArrayContext {
  readonly capName: string
  readonly itemArray: ItemArray
  readonly reserved: ReadonlySet<string>
  readonly featureIndex: number
  readonly lookupCap: CapabilityLookup
  /** On an existing target, decides each leaf's unavailable mode (`unavailableFor`). */
  readonly mode: CompositionFeatureMode
}

function missingLeaves(
  { capName, itemArray, reserved }: ItemArrayContext,
  item: CompositionItemEntry,
  at: string,
): readonly CompositionProblem[] {
  const written = Object.keys(item.fields)
  return enumerateSchemaFields(itemArray.itemSchema).flatMap(
    (leaf): readonly CompositionProblem[] => {
      if (reserved.has(leaf.path) || leaf.path in item.fields) return []
      if (!leafRequired(itemArray, leaf.path, written)) return []
      const described = describeStateField(itemArray.itemSchema, leaf.path)
      // A nullable leaf with no source is written `null` by the composer.
      if (described === null || described.nullable) return []
      return [
        problem(
          'missing-field',
          `${at}.fields.${leaf.path}`,
          `\`${capName}.${itemArray.path}[].${leaf.path}\` is required and has no source`,
        ),
      ]
    },
  )
}

/** Which item leaf is being planned: the item's key and label, and the path inside it. */
interface ItemLeaf {
  readonly key: string
  readonly label: string
  readonly path: string
  readonly source: CompositionFieldSource
}

function planItemField(ctx: ItemArrayContext, leaf: ItemLeaf): CompositionPlanResult {
  const { capName, itemArray, featureIndex, lookupCap } = ctx
  const { key, label, path, source } = leaf
  const at = `features[${featureIndex}].items.${key}.fields.${path}`
  if (ctx.reserved.has(path)) {
    return refused(
      problem(
        'item-field-reserved',
        at,
        `\`${capName}.${itemArray.path}[].${path}\` is set by the composer itself — it takes no source`,
      ),
    )
  }
  const tf = describeStateField(itemArray.itemSchema, path)
  if (tf === null) {
    return refused(problem('unknown-field', at, `a \`${capName}\` item has no field \`${path}\``))
  }
  const kinds = sourceKinds(source, lookupCap)
  if (!kinds.ok) return refused(problem(kinds.code, at, kinds.message))
  const role = roleOf(source)
  const unavailable = unavailableFor(tf, role, ctx.mode, capName, at)
  if (!unavailable.ok) return refused(unavailable.problem)
  const plan: CompositionFieldPlan = {
    cap: capName,
    path,
    item: { arrayPath: itemArray.path, key, label },
    featureIndex,
    kind: tf.kind,
    nullable: tf.nullable,
    // Relative to the leaf's own schema: a leaf under an OPTIONAL parent
    // (`remaining.unit`) reads `true` although it is required only once that
    // parent is written (missingLeaves applies that rule).
    required: tf.required,
    unavailable: unavailable.unavailable,
    role,
    source,
    reads: [...fieldReads(source)],
  }
  const enumProblem = enumLiteralProblem(capName, tf, source, at)
  return {
    problems: [
      ...compatibility(capName, tf, kinds.kinds, at),
      ...(enumProblem === null ? [] : [enumProblem]),
    ],
    fields: [plan],
    features: [],
    events: [],
  }
}

export function planItems(
  def: CapabilityDefinition,
  feature: CompositionFieldsFeature,
  featureIndex: number,
  lookupCap: CapabilityLookup,
  mode: CompositionFeatureMode = 'new',
): CompositionPlanResult {
  const at = `features[${featureIndex}].items`
  const itemArray = def.status?.itemArray
  if (itemArray === undefined) {
    return refused(
      problem('not-item-array', at, `\`${def.name}\` has no item array — it takes no \`items\``),
    )
  }
  if (itemArray.path !== COMPOSITION_ITEM_ARRAY_PATH) {
    // The field graph keys item leaves under COMPOSITION_ITEM_ARRAY_PATH (it has
    // no cap lookup); a cap whose array lives elsewhere would get wrong keys.
    return refused(
      problem(
        'not-item-array',
        at,
        `\`${def.name}\`'s item array is at \`${itemArray.path}\`, not \`${COMPOSITION_ITEM_ARRAY_PATH}\` — not composable yet`,
      ),
    )
  }
  const ctx: ItemArrayContext = {
    capName: def.name,
    itemArray,
    reserved: reservedItemFields(itemArray),
    featureIndex,
    lookupCap,
    mode,
  }
  const results = Object.entries(feature.items ?? {}).flatMap(([key, item]) => [
    { problems: missingLeaves(ctx, item, `${at}.${key}`), fields: [], features: [], events: [] },
    ...Object.entries(item.fields).map(([path, source]) =>
      planItemField(ctx, { key, label: item.label, path, source }),
    ),
  ])
  return {
    problems: results.flatMap((r) => r.problems),
    fields: results.flatMap((r) => r.fields),
    features: [],
    events: [],
  }
}
