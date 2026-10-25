/**
 * Every edit an operator can make to a condition tree — as pure functions, so
 * the rules that matter can be tested without mounting the page.
 *
 * Two decisions are encoded here and neither is cosmetic.
 *
 * **1. Grouping is an operation on rows that already exist.** There is no
 * "add a group" — a container is created by selecting two or more sibling rows
 * and choosing what they mean together. An empty container is not a step on the
 * way to anything: it is a tree the schema rejects
 * (`validateRecipeBounds` names it) and a screen that shows the operator a box
 * they have to remember to fill.
 *
 * **2. A refusal is the generator's own words.** `validateRecipeBounds` is the
 * single authority on depth and leaf budgets, and its depth message already
 * offers the De Morgan rewrite. Nothing here re-words it, so an editor refusal
 * and a save refusal can never say different things about the same tree.
 *
 * Addressing is by {@link ConditionPath} — child indices from the root
 * container, where a `not` has exactly one child at index 0. The empty path is
 * the root itself.
 */

import {
  type AutomationCondition,
  type AutomationConditionAll,
  type AutomationConditionAny,
  type AutomationRecipe,
  conditionDepth,
  countConditionLeaves,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_LEAVES,
  validateRecipeBounds,
} from '@camstack/types'
import i18n from '../../../i18n/index'

export type ConditionPath = readonly number[]

/** The two shapes the tree's root may take. `not` and the leaves are never the
 *  root: the editor's top level is a list, and a list has a joiner. */
export type ConditionContainer = AutomationConditionAll | AutomationConditionAny
export type ContainerKind = ConditionContainer['kind']

/** An edit that the bounds may refuse. The reason is shown verbatim. */
export type RecipeEdit =
  | { readonly ok: true; readonly recipe: AutomationRecipe }
  | { readonly ok: false; readonly reason: string }

export interface ConditionBudget {
  readonly depth: number
  readonly leaves: number
  readonly depthLimit: number
  readonly leafLimit: number
}

export function isContainer(node: AutomationCondition): node is ConditionContainer {
  return node.kind === 'all' || node.kind === 'any'
}

/**
 * The tree as the editor renders it: always a container, possibly empty.
 *
 * A recipe authored elsewhere may carry a bare leaf as `conditions`; wrapping it
 * is semantically identical and it is what makes every row addressable by the
 * same path scheme. {@link normalizeRecipe} writes the wrap back so what is on
 * screen and what will be saved are the same tree.
 */
export function conditionRoot(recipe: AutomationRecipe): ConditionContainer {
  const cond = recipe.conditions
  if (cond === undefined) return { kind: 'all', children: [] }
  if (isContainer(cond)) return cond
  return { kind: 'all', children: [cond] }
}

/** Attach a tree — or drop the key entirely when there is nothing to say. An
 *  empty container would be a bound violation, not an empty condition set. */
export function withConditions(
  recipe: AutomationRecipe,
  cond: AutomationCondition | null,
): AutomationRecipe {
  if (cond === null || (isContainer(cond) && cond.children.length === 0)) {
    return { triggers: recipe.triggers, actions: recipe.actions }
  }
  return { triggers: recipe.triggers, actions: recipe.actions, conditions: cond }
}

/** Hydrate a recipe into the shape the editor's paths address. */
export function normalizeRecipe(recipe: AutomationRecipe): AutomationRecipe {
  return withConditions(recipe, conditionRoot(recipe))
}

export function nodeAt(node: AutomationCondition, path: ConditionPath): AutomationCondition | null {
  if (path.length === 0) return node
  const [head, ...rest] = path
  if (head === undefined) return node
  if (node.kind === 'not') return head === 0 ? nodeAt(node.child, rest) : null
  if (!isContainer(node)) return null
  const child = node.children[head]
  return child === undefined ? null : nodeAt(child, rest)
}

/**
 * Rebuild the tree with one node replaced — or removed, when `edit` returns
 * `null`.
 *
 * Removal CASCADES: dropping the child of a `not` drops the `not`, and dropping
 * the last child of a container drops the container. That is the mechanism that
 * makes "no empty container can exist" true rather than a thing the UI
 * remembers to check.
 */
function editAt(
  node: AutomationCondition,
  path: ConditionPath,
  edit: (target: AutomationCondition) => AutomationCondition | null,
): AutomationCondition | null {
  if (path.length === 0) return edit(node)
  const [head, ...rest] = path
  if (head === undefined) return edit(node)

  if (node.kind === 'not') {
    if (head !== 0) return node
    const next = editAt(node.child, rest, edit)
    return next === null ? null : { kind: 'not', child: next }
  }
  if (!isContainer(node)) return node

  const child = node.children[head]
  if (child === undefined) return node
  const next = editAt(child, rest, edit)
  const children =
    next === null
      ? [...node.children.slice(0, head), ...node.children.slice(head + 1)]
      : [...node.children.slice(0, head), next, ...node.children.slice(head + 1)]
  if (children.length === 0) return null
  return { kind: node.kind, children }
}

/**
 * The condition budget, asked of the ONE function that owns it.
 *
 * `validateRecipeBounds` also refuses an automation with no triggers or no
 * actions — true of every automation halfway through being authored, and
 * nothing to do with the tree edit being attempted. The probe therefore carries
 * one placeholder of each, so the only bound that can fail is the one under
 * test and the message that comes back is always about conditions.
 */
function conditionBoundsError(cond: AutomationCondition | null): string | null {
  if (cond === null) return null
  return validateRecipeBounds({
    triggers: [{ kind: 'manual' }],
    actions: [{ kind: 'wait', seconds: 0 }],
    conditions: cond,
  })
}

/** Live counters for the editor header. */
export function conditionBudget(recipe: AutomationRecipe): ConditionBudget {
  const root = conditionRoot(recipe)
  return {
    depth: root.children.length === 0 ? 0 : conditionDepth(root),
    leaves: root.children.length === 0 ? 0 : countConditionLeaves(root),
    depthLimit: MAX_CONDITION_DEPTH,
    leafLimit: MAX_CONDITION_LEAVES,
  }
}

function commit(recipe: AutomationRecipe, next: AutomationCondition | null): RecipeEdit {
  const reason = conditionBoundsError(next)
  if (reason !== null) return { ok: false, reason }
  return { ok: true, recipe: withConditions(recipe, next) }
}

/** Append a row to the root list. New rows always land in the implicit root —
 *  grouping is how they get anywhere else. */
export function addCondition(recipe: AutomationRecipe, leaf: AutomationCondition): RecipeEdit {
  const root = conditionRoot(recipe)
  return commit(recipe, { kind: root.kind, children: [...root.children, leaf] })
}

export function updateCondition(
  recipe: AutomationRecipe,
  path: ConditionPath,
  next: AutomationCondition,
): AutomationRecipe {
  const updated = editAt(conditionRoot(recipe), path, () => next)
  return withConditions(recipe, updated)
}

export function removeCondition(recipe: AutomationRecipe, path: ConditionPath): AutomationRecipe {
  const updated = editAt(conditionRoot(recipe), path, () => null)
  return withConditions(recipe, updated)
}

/** Flip a container between ALL and ANY. Never changes shape, so it can never
 *  break a bound. */
export function setContainerKind(
  recipe: AutomationRecipe,
  path: ConditionPath,
  kind: ContainerKind,
): AutomationRecipe {
  const updated = editAt(conditionRoot(recipe), path, (target) =>
    isContainer(target) ? { kind, children: target.children } : target,
  )
  return withConditions(recipe, updated)
}

/**
 * Wrap a row in NOT, or unwrap one that already is.
 *
 * A toggle rather than two verbs because `not(not(x))` is `x` — offering it as
 * a container the operator can stack invites a tree that costs two depth levels
 * to say nothing.
 */
export function toggleNot(recipe: AutomationRecipe, path: ConditionPath): RecipeEdit {
  const target = nodeAt(conditionRoot(recipe), path)
  if (target === null) return { ok: false, reason: i18n.t('helpers.recipeOps.rowGone') }
  const updated = editAt(conditionRoot(recipe), path, (node) =>
    node.kind === 'not' ? node.child : { kind: 'not', child: node },
  )
  return commit(recipe, updated)
}

interface ParentRef {
  readonly path: ConditionPath
  readonly index: number
}

function parentOf(path: ConditionPath): ParentRef | null {
  if (path.length === 0) return null
  const index = path[path.length - 1]
  if (index === undefined) return null
  return { path: path.slice(0, -1), index }
}

/**
 * Turn selected sibling rows into one group.
 *
 * Every refusal is a sentence an operator can act on, and the bound refusal is
 * `validateRecipeBounds`' own — it is the one that says a fourth level is not
 * needed because `not (any of …)` is `all of (not …)`.
 */
export function groupSelection(
  recipe: AutomationRecipe,
  paths: readonly ConditionPath[],
  kind: ContainerKind,
): RecipeEdit {
  if (paths.length < 2) {
    return { ok: false, reason: i18n.t('helpers.recipeOps.selectTwo') }
  }
  const parents = new Set(paths.map((p) => p.slice(0, -1).join('/')))
  if (parents.size !== 1) {
    return {
      ok: false,
      reason: i18n.t('helpers.recipeOps.differentGroups'),
    }
  }
  const first = parentOf(paths[0] ?? [])
  if (first === null) return { ok: false, reason: i18n.t('helpers.recipeOps.rootGroup') }

  const root = conditionRoot(recipe)
  const parent = nodeAt(root, first.path)
  if (parent === null || !isContainer(parent)) {
    return { ok: false, reason: i18n.t('helpers.recipeOps.insideNot') }
  }

  const indices = [...paths.map((p) => p[p.length - 1] ?? -1)].sort((a, b) => a - b)
  const selected = indices
    .map((i) => parent.children[i])
    .filter((child): child is AutomationCondition => child !== undefined)
  if (selected.length !== indices.length) {
    return { ok: false, reason: i18n.t('helpers.recipeOps.selectedGone') }
  }

  const rest = parent.children.filter((_, i) => !indices.includes(i))
  const insertAt = indices[0] ?? 0
  const group: ConditionContainer = { kind, children: selected }
  const nextParent: ConditionContainer = {
    kind: parent.kind,
    children: [...rest.slice(0, insertAt), group, ...rest.slice(insertAt)],
  }
  return commit(
    recipe,
    editAt(root, first.path, () => nextParent),
  )
}

/**
 * Dissolve a group, putting its rows back where the group was.
 *
 * The inverse of {@link groupSelection}, and the only reason grouping is safe to
 * offer: an operator who groups the wrong two rows is one click from undoing it.
 */
export function ungroup(recipe: AutomationRecipe, path: ConditionPath): RecipeEdit {
  if (path.length === 0) {
    return { ok: false, reason: i18n.t('helpers.recipeOps.outerNotGroup') }
  }
  const root = conditionRoot(recipe)
  const target = nodeAt(root, path)
  if (target === null) return { ok: false, reason: i18n.t('helpers.recipeOps.groupGone') }
  if (target.kind === 'not') {
    return commit(
      recipe,
      editAt(root, path, () => target.child),
    )
  }
  if (!isContainer(target)) {
    return { ok: false, reason: i18n.t('helpers.recipeOps.rowIsCondition') }
  }

  const ref = parentOf(path)
  if (ref === null) return { ok: false, reason: i18n.t('helpers.recipeOps.noParent') }
  const parent = nodeAt(root, ref.path)
  if (parent === null || !isContainer(parent)) {
    return { ok: false, reason: i18n.t('helpers.recipeOps.groupInNot') }
  }
  const nextParent: ConditionContainer = {
    kind: parent.kind,
    children: [
      ...parent.children.slice(0, ref.index),
      ...target.children,
      ...parent.children.slice(ref.index + 1),
    ],
  }
  return commit(
    recipe,
    editAt(root, ref.path, () => nextParent),
  )
}
