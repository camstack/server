/**
 * Every edit an operator can make to the `when` tree — as pure functions, so the
 * rules that matter can be tested without mounting the page.
 *
 * The tree is edited in place and MAY pass through an illegal shape (a block
 * holding two events under ALL, a block nested too deep): {@link whenIssues}
 * attributes the refusal to the lowest block it belongs to, and the editor
 * shows the engine's own sentence there. Save stays blocked until it is fixed.
 * Nothing here re-words `validateWhenTree`, so the editor and the save path can
 * never say different things about the same tree.
 *
 * Addressing is by {@link WhenPath} — child indices from the root block, where
 * a `not` has exactly one child at index 0 (the scheme the run trace uses:
 * `when`, `when.0`, `when.0.1`). The empty path is the root itself.
 *
 * Removal CASCADES: dropping the child of a `not` drops the `not`, and dropping
 * the last child of a block drops the block (the root only empties). That is
 * why no empty block exists apart from the root of a fresh automation.
 */

import {
  type AutomationAll,
  type AutomationAny,
  type AutomationLeaf,
  type AutomationRecipe,
  type AutomationWhen,
  countWhenLeaves,
  isLeaf,
  MAX_WHEN_DEPTH,
  MAX_WHEN_LEAVES,
  validateWhenTree,
  whenDepth,
} from '@camstack/types'
import { type LeafKind, newLeaf } from './recipe-parts'

export type WhenPath = readonly number[]

/** The shapes a block takes. A `not` is not a block of its own: it wraps one row or block. */
export type WhenContainer = AutomationAll | AutomationAny
export type ContainerKind = WhenContainer['kind']

export interface WhenBudget {
  readonly depth: number
  readonly leaves: number
  readonly depthLimit: number
  readonly leafLimit: number
}

export function isContainer(node: AutomationWhen): node is WhenContainer {
  return node.kind === 'all' || node.kind === 'any'
}

/** Path key, the identity of a node in a React list and in a trace. */
export function pathKey(path: WhenPath): string {
  return ['when', ...path].join('.')
}

/**
 * The tree as the editor renders it: always a block, possibly empty. A recipe
 * authored elsewhere may carry a bare row or a `not` as its root; wrapping it
 * is semantically identical and makes every node addressable the same way.
 */
export function whenRoot(recipe: AutomationRecipe): WhenContainer {
  const when = recipe.when
  return isContainer(when) ? when : { kind: 'all', children: [when] }
}

export function withWhen(recipe: AutomationRecipe, when: AutomationWhen): AutomationRecipe {
  return { ...recipe, when }
}

/** Hydrate a recipe into the shape the editor's paths address. */
export function normalizeRecipe(recipe: AutomationRecipe): AutomationRecipe {
  return withWhen(recipe, whenRoot(recipe))
}

export function nodeAt(node: AutomationWhen, path: WhenPath): AutomationWhen | null {
  const [head, ...rest] = path
  if (head === undefined) return node
  if (node.kind === 'not') return head === 0 ? nodeAt(node.child, rest) : null
  if (isLeaf(node)) return null
  const child = node.children[head]
  return child === undefined ? null : nodeAt(child, rest)
}

/** Rebuild the tree with one node replaced — or removed, when `edit` returns `null`. */
function editAt(
  node: AutomationWhen,
  path: WhenPath,
  edit: (target: AutomationWhen) => AutomationWhen | null,
): AutomationWhen | null {
  const [head, ...rest] = path
  if (head === undefined) return edit(node)
  if (node.kind === 'not') {
    if (head !== 0) return node
    const next = editAt(node.child, rest, edit)
    return next === null ? null : { kind: 'not', child: next }
  }
  if (isLeaf(node)) return node
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

function applyEdit(
  recipe: AutomationRecipe,
  path: WhenPath,
  edit: (target: AutomationWhen) => AutomationWhen | null,
): AutomationRecipe {
  const root = whenRoot(recipe)
  const next = editAt(root, path, edit)
  return withWhen(recipe, next ?? { kind: root.kind, children: [] })
}

/** A block with one blank row in it: the editor never creates an empty block. */
export function seedBlock(kind: ContainerKind): WhenContainer {
  return { kind, children: [newLeaf('device-is')] }
}

/** Append a row or block to the block at `path`. */
export function addNode(
  recipe: AutomationRecipe,
  path: WhenPath,
  node: AutomationWhen,
): AutomationRecipe {
  return applyEdit(recipe, path, (target) =>
    isContainer(target) ? { kind: target.kind, children: [...target.children, node] } : target,
  )
}

export function updateNode(
  recipe: AutomationRecipe,
  path: WhenPath,
  next: AutomationWhen,
): AutomationRecipe {
  return applyEdit(recipe, path, () => next)
}

export function removeNode(recipe: AutomationRecipe, path: WhenPath): AutomationRecipe {
  return applyEdit(recipe, path, () => null)
}

/** Flip a block between ALL and ANY. */
export function setContainerKind(
  recipe: AutomationRecipe,
  path: WhenPath,
  kind: ContainerKind,
): AutomationRecipe {
  return applyEdit(recipe, path, (target) =>
    isContainer(target) ? { kind, children: target.children } : target,
  )
}

/** Wrap a row or block in NOT. The root cannot be negated. */
export function negate(recipe: AutomationRecipe, path: WhenPath): AutomationRecipe {
  if (path.length === 0) return recipe
  return applyEdit(recipe, path, (node) => ({ kind: 'not', child: node }))
}

/** Remove the NOT at `path`, keeping what it wrapped. */
export function unnegate(recipe: AutomationRecipe, path: WhenPath): AutomationRecipe {
  return applyEdit(recipe, path, (node) => (node.kind === 'not' ? node.child : node))
}

/** Dissolve the block at `path` into its parent, keeping its rows. */
export function ungroup(recipe: AutomationRecipe, path: WhenPath): AutomationRecipe {
  const root = whenRoot(recipe)
  const target = nodeAt(root, path)
  const parentPath = path.slice(0, -1)
  const index = path[path.length - 1]
  const parent = nodeAt(root, parentPath)
  if (target === null || !isContainer(target) || index === undefined) return recipe
  if (parent === null || !isContainer(parent)) return recipe
  return applyEdit(recipe, parentPath, () => ({
    kind: parent.kind,
    children: [
      ...parent.children.slice(0, index),
      ...target.children,
      ...parent.children.slice(index + 1),
    ],
  }))
}

/**
 * Change a row's type. The device field a "becomes" row watches is the one an
 * "is" row compares, so switching between those two keeps the field (and a
 * plain value); every other switch starts from a blank row of the new type.
 */
export function convertLeafKind(leaf: AutomationLeaf, kind: LeafKind): AutomationLeaf {
  if (leaf.kind === kind) return leaf
  if (leaf.kind === 'device-is' && kind === 'device-becomes') {
    const { deviceId, cap, fieldPath, operator, value } = leaf
    const base = { kind, deviceId, cap, fieldPath } as const
    return operator === 'eq' && !Array.isArray(value) && typeof value !== 'object'
      ? { ...base, becomes: value }
      : base
  }
  if (leaf.kind === 'device-becomes' && kind === 'device-is') {
    const { deviceId, cap, fieldPath, becomes } = leaf
    return { kind, deviceId, cap, fieldPath, operator: 'eq', value: becomes ?? '' }
  }
  return newLeaf(kind)
}

/** Live counters for the editor header. */
export function whenBudget(recipe: AutomationRecipe): WhenBudget {
  const root = whenRoot(recipe)
  const empty = root.children.length === 0
  return {
    depth: empty ? 0 : whenDepth(root),
    leaves: empty ? 0 : countWhenLeaves(root),
    depthLimit: MAX_WHEN_DEPTH,
    leafLimit: MAX_WHEN_LEAVES,
  }
}

/** Whether a block at this path may take another nested block (with its seed row). */
export function canNestBlockAt(recipe: AutomationRecipe, path: WhenPath): boolean {
  const root = whenRoot(recipe)
  // Levels from the root down to the block, `not` wrappers included; the new
  // block and its seed row add two more.
  let levels = 1
  let node: AutomationWhen = root
  for (const index of path) {
    const next = nodeAt(node, [index])
    if (next === null) break
    levels += 1
    node = next
  }
  return levels + 2 <= MAX_WHEN_DEPTH
}

/**
 * What `validateWhenTree` objects to, attributed to the LOWEST block (or `not`)
 * whose own subtree is already refused — so "two events under ALL" lands on
 * that ALL, not on the root, and a message is never repeated up the chain.
 * Keyed by {@link pathKey}.
 */
export function whenIssues(when: AutomationWhen): ReadonlyMap<string, string> {
  const issues = new Map<string, string>()
  const visit = (node: AutomationWhen, path: WhenPath): boolean => {
    if (isLeaf(node)) return false
    const kids = node.kind === 'not' ? [node.child] : node.children
    let below = false
    kids.forEach((child, index) => {
      if (visit(child, [...path, index])) below = true
    })
    if (below) return true
    const message = validateWhenTree(node)
    if (message === null) return false
    issues.set(pathKey(path), message)
    return true
  }
  visit(when, [])
  return issues
}
