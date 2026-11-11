/**
 * The model of a `triggered-by` row. The row names trigger rows by a stable id
 * (a path moves when a row is reordered), and an operator never types one: the
 * editor gives every trigger row an id as soon as some row asks which trigger
 * fired, and the row offers the automation's own trigger rows as toggles.
 */
import type {
  AutomationEventLeaf,
  AutomationRecipe,
  AutomationWhen,
  TriggeredByLeaf,
} from '@camstack/types'
import {
  forEachLeaf,
  hasTriggeredByLeaves,
  isEventLeaf,
  isLeaf,
  stepConditionsOf,
} from '@camstack/types'

/** One trigger row a `triggered-by` row can name. */
export interface TriggerRow {
  readonly id: string
  /** Its place among ALL the trigger rows of the tree, from 1: what the operator counts on screen. */
  readonly ordinal: number
  readonly leaf: AutomationEventLeaf
}

/** The trigger rows that carry an id, in tree order. */
export function triggerRowsOf(when: AutomationWhen): readonly TriggerRow[] {
  const rows: TriggerRow[] = []
  let ordinal = 0
  forEachLeaf(when, (leaf) => {
    if (!isEventLeaf(leaf)) return
    ordinal += 1
    if (leaf.id !== undefined) rows.push({ id: leaf.id, ordinal, leaf })
  })
  return rows
}

function asksForTrigger(recipe: AutomationRecipe): boolean {
  if (hasTriggeredByLeaves(recipe.when)) return true
  return recipe.actions.some((action) =>
    stepConditionsOf(action).some((condition) => hasTriggeredByLeaves(condition.when)),
  )
}

function nextFreeId(taken: ReadonlySet<string>): string {
  let n = 1
  while (taken.has(`t${n}`)) n += 1
  return `t${n}`
}

function nameTriggerRows(node: AutomationWhen, taken: Set<string>): AutomationWhen {
  if (isLeaf(node)) {
    if (!isEventLeaf(node) || node.id !== undefined) return node
    const id = nextFreeId(taken)
    taken.add(id)
    return { ...node, id }
  }
  if (node.kind === 'not') {
    const child = nameTriggerRows(node.child, taken)
    return child === node.child ? node : { ...node, child }
  }
  const children = node.children.map((child) => nameTriggerRows(child, taken))
  return children.every((child, i) => child === node.children[i]) ? node : { ...node, children }
}

/**
 * Give every trigger row an id once a row of the recipe asks which trigger
 * fired. A recipe that never asks, or whose trigger rows are all named, comes
 * back as the SAME object.
 */
export function ensureTriggerIds(recipe: AutomationRecipe): AutomationRecipe {
  if (!asksForTrigger(recipe)) return recipe
  const taken = new Set(triggerRowsOf(recipe.when).map((row) => row.id))
  const when = nameTriggerRows(recipe.when, taken)
  return when === recipe.when ? recipe : { ...recipe, when }
}

/** Press or release one trigger. The result keeps the rows' order and drops ids no row carries. */
export function toggleTrigger(
  leaf: TriggeredByLeaf,
  id: string,
  rowIds: readonly string[],
): TriggeredByLeaf {
  const wanted = leaf.leafIds.includes(id)
    ? leaf.leafIds.filter((current) => current !== id)
    : [...leaf.leafIds, id]
  return { kind: 'triggered-by', leafIds: rowIds.filter((rowId) => wanted.includes(rowId)) }
}

/** The chosen ids no trigger row carries (a row that was removed). */
export function missingTriggers(
  leaf: TriggeredByLeaf,
  rowIds: readonly string[],
): readonly string[] {
  return leaf.leafIds.filter((id) => !rowIds.includes(id))
}
