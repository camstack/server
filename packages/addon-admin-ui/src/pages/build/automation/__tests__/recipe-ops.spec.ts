/**
 * The tree edits, and the two invariants they exist to hold.
 *
 *  1. **No empty container can be produced.** Not by grouping (which needs rows
 *     that already exist), not by deleting (which cascades), not by ungrouping.
 *     Every test below re-asserts it through `validateRecipeBounds`, which is
 *     the same function the save path runs.
 *  2. **A refusal is the generator's own sentence.** The depth message is
 *     asserted verbatim-ish, including the De Morgan hint, because an editor
 *     that paraphrases it would drift from what the save path says about the
 *     same tree.
 */

import {
  type AutomationCondition,
  type AutomationConditionLeaf,
  type AutomationRecipe,
  MAX_CONDITION_LEAVES,
  validateRecipeBounds,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  addCondition,
  conditionBudget,
  conditionRoot,
  groupSelection,
  normalizeRecipe,
  removeCondition,
  setContainerKind,
  toggleNot,
  ungroup,
  updateCondition,
} from '../recipe-ops'

function leaf(deviceId: number): AutomationConditionLeaf {
  return {
    kind: 'condition',
    deviceId,
    cap: 'power-switch',
    fieldPath: 'on',
    operator: 'eq',
    value: true,
  }
}

/** Deliberately EMPTY in both other halves — that is the state every automation
 *  is in while its conditions are being authored, and grouping must work there.
 *  A bounds probe that failed on "needs at least one trigger" would refuse every
 *  grouping in a brand-new automation. */
const DRAFT: AutomationRecipe = { triggers: [], actions: [] }

function withLeaves(count: number): AutomationRecipe {
  let recipe = DRAFT
  for (let i = 0; i < count; i += 1) {
    const edit = addCondition(recipe, leaf(i + 1))
    if (!edit.ok) throw new Error(`unexpected refusal: ${edit.reason}`)
    recipe = edit.recipe
  }
  return recipe
}

/** Every op must leave a tree the SAVE path also accepts. */
function expectLegalTree(recipe: AutomationRecipe): void {
  const probe: AutomationRecipe = {
    triggers: [{ kind: 'manual' }],
    actions: [{ kind: 'wait', seconds: 0 }],
    ...(recipe.conditions === undefined ? {} : { conditions: recipe.conditions }),
  }
  expect(validateRecipeBounds(probe)).toBeNull()
}

describe('adding and removing', () => {
  it('puts a new row in the implicit root ALL', () => {
    const recipe = withLeaves(2)
    const root = conditionRoot(recipe)
    expect(root.kind).toBe('all')
    expect(root.children).toHaveLength(2)
    expectLegalTree(recipe)
  })

  it('drops `conditions` entirely when the last row goes', () => {
    const recipe = removeCondition(withLeaves(1), [0])
    expect(recipe.conditions).toBeUndefined()
    expectLegalTree(recipe)
  })

  it('removes a group when its last child is removed, rather than leaving it empty', () => {
    const grouped = groupSelection(withLeaves(3), [[0], [1]], 'any')
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return

    const one = removeCondition(grouped.recipe, [0, 0])
    const none = removeCondition(one, [0, 0])

    // The group is gone, not empty — an empty container is a bound violation.
    expect(conditionRoot(none).children).toHaveLength(1)
    expectLegalTree(none)
  })

  it('refuses a leaf past the budget, in the words the save path uses', () => {
    const full = withLeaves(MAX_CONDITION_LEAVES)
    const edit = addCondition(full, leaf(999))
    expect(edit.ok).toBe(false)
    if (!edit.ok) expect(edit.reason).toContain(`the limit is ${String(MAX_CONDITION_LEAVES)}`)
  })

  it('replaces a row in place, immutably', () => {
    const before = withLeaves(2)
    const after = updateCondition(before, [1], leaf(42))

    expect(conditionRoot(after).children[1]).toEqual(leaf(42))
    // The original is untouched — the editor holds it as state and re-renders
    // from it, so an in-place mutation would show the new value under the old
    // identity and skip the render entirely.
    expect(conditionRoot(before).children[1]).toEqual(leaf(2))
  })
})

describe('grouping', () => {
  it('groups two sibling rows and keeps their order and position', () => {
    const edit = groupSelection(withLeaves(3), [[1], [2]], 'any')
    expect(edit.ok).toBe(true)
    if (!edit.ok) return

    const children = conditionRoot(edit.recipe).children
    expect(children).toHaveLength(2)
    expect(children[0]).toEqual(leaf(1))

    const group = children[1]
    expect(group?.kind).toBe('any')
    if (group !== undefined && group.kind === 'any') {
      expect(group.children).toEqual([leaf(2), leaf(3)])
    }
    expectLegalTree(edit.recipe)
  })

  it('inserts the group where the FIRST selected row was', () => {
    const edit = groupSelection(withLeaves(3), [[0], [2]], 'all')
    expect(edit.ok).toBe(true)
    if (!edit.ok) return

    const children = conditionRoot(edit.recipe).children
    expect(children[0]?.kind).toBe('all')
    expect(children[1]).toEqual(leaf(2))
  })

  it('works on a draft with no triggers and no actions', () => {
    // The bounds probe must not refuse on "needs at least one trigger" — that is
    // true of every automation halfway through being authored.
    const edit = groupSelection(withLeaves(2), [[0], [1]], 'any')
    expect(edit.ok).toBe(true)
  })

  it('refuses one row', () => {
    const edit = groupSelection(withLeaves(2), [[0]], 'any')
    expect(edit.ok).toBe(false)
    if (!edit.ok) expect(edit.reason).toContain('at least two rows')
  })

  it('refuses rows that are not siblings', () => {
    const grouped = groupSelection(withLeaves(3), [[0], [1]], 'any')
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return

    const edit = groupSelection(grouped.recipe, [[0, 0], [1]], 'all')
    expect(edit.ok).toBe(false)
    if (!edit.ok) expect(edit.reason).toContain('different groups')
  })

  it('refuses a fourth level and offers the De Morgan rewrite verbatim', () => {
    const first = groupSelection(withLeaves(4), [[0], [1], [2]], 'any')
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // root(all) > group(any) > another group would be level 4.
    const second = groupSelection(
      first.recipe,
      [
        [0, 0],
        [0, 1],
      ],
      'all',
    )
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.reason).toContain('the limit is 3')
      expect(second.reason).toContain('"not (any of …)" is the same as "all of (not …)"')
    }
  })

  it('ungroup is the inverse of group', () => {
    const before = withLeaves(3)
    const grouped = groupSelection(before, [[1], [2]], 'any')
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return

    const restored = ungroup(grouped.recipe, [1])
    expect(restored.ok).toBe(true)
    if (!restored.ok) return

    expect(conditionRoot(restored.recipe).children).toEqual(conditionRoot(before).children)
    expectLegalTree(restored.recipe)
  })

  it('refuses to dissolve the outer list', () => {
    const edit = ungroup(withLeaves(2), [])
    expect(edit.ok).toBe(false)
    if (!edit.ok) expect(edit.reason).toContain('not a group')
  })
})

describe('NOT', () => {
  it('wraps a row and unwraps it again', () => {
    const wrapped = toggleNot(withLeaves(2), [0])
    expect(wrapped.ok).toBe(true)
    if (!wrapped.ok) return

    const first: AutomationCondition | undefined = conditionRoot(wrapped.recipe).children[0]
    expect(first?.kind).toBe('not')
    expectLegalTree(wrapped.recipe)

    const unwrapped = toggleNot(wrapped.recipe, [0])
    expect(unwrapped.ok).toBe(true)
    if (unwrapped.ok) expect(conditionRoot(unwrapped.recipe).children[0]).toEqual(leaf(1))
  })

  it('refuses a NOT that would cost a fourth level', () => {
    const grouped = groupSelection(withLeaves(3), [[0], [1]], 'any')
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return

    // root(all) > any > not > leaf is four.
    const edit = toggleNot(grouped.recipe, [0, 0])
    expect(edit.ok).toBe(false)
    if (!edit.ok) expect(edit.reason).toContain('the limit is 3')
  })
})

describe('root and budget', () => {
  it('flips the root joiner without touching the rows', () => {
    const recipe = setContainerKind(withLeaves(2), [], 'any')
    const root = conditionRoot(recipe)
    expect(root.kind).toBe('any')
    expect(root.children).toEqual([leaf(1), leaf(2)])
  })

  it('normalises a bare leaf into the root container so paths address it', () => {
    const bare: AutomationRecipe = { triggers: [], actions: [], conditions: leaf(7) }
    const normalised = normalizeRecipe(bare)
    expect(normalised.conditions).toEqual({ kind: 'all', children: [leaf(7)] })
  })

  it('reports 0/0 for a tree with nothing in it', () => {
    expect(conditionBudget(DRAFT)).toEqual({ depth: 0, leaves: 0, depthLimit: 3, leafLimit: 32 })
  })

  it('counts leaves, not containers', () => {
    const grouped = groupSelection(withLeaves(3), [[0], [1]], 'any')
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return

    const budget = conditionBudget(grouped.recipe)
    expect(budget.leaves).toBe(3)
    expect(budget.depth).toBe(3)
  })
})
