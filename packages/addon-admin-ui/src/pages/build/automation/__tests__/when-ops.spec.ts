import type { AutomationLeaf, AutomationRecipe } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { EMPTY_RECIPE } from '../recipe-parts'
import {
  addNode,
  canNestBlockAt,
  convertLeafKind,
  negate,
  nodeAt,
  pathKey,
  removeNode,
  seedBlock,
  setContainerKind,
  ungroup,
  unnegate,
  whenBudget,
  whenIssues,
} from '../when-ops'

const IS: AutomationLeaf = {
  kind: 'device-is',
  deviceId: 7,
  cap: 'pet-feeder',
  fieldPath: 'hopperLevel',
  operator: 'eq',
  value: 3,
}
const BECOMES: AutomationLeaf = {
  kind: 'device-becomes',
  deviceId: 7,
  cap: 'pet-feeder',
  fieldPath: 'hopperLevel',
  becomes: 3,
}
const MANUAL: AutomationLeaf = { kind: 'manual' }

function recipeOf(...children: AutomationRecipe['when'][]): AutomationRecipe {
  return { ...EMPTY_RECIPE, when: { kind: 'all', children } }
}

describe('when-ops', () => {
  it('adds a block inside a block, where the operator pressed Add block', () => {
    const base = recipeOf(IS)
    const next = addNode(base, [], seedBlock('any'))
    expect(next.when).toMatchObject({
      kind: 'all',
      children: [IS, { kind: 'any', children: [{ kind: 'device-is' }] }],
    })
    const deeper = addNode(next, [1], BECOMES)
    expect(nodeAt(deeper.when, [1, 1])).toEqual(BECOMES)
    expect(base.when).toEqual({ kind: 'all', children: [IS] })
  })

  it('removing the last row of a block removes the block, but the root only empties', () => {
    const nested = recipeOf(IS, { kind: 'any', children: [MANUAL] })
    expect(removeNode(nested, [1, 0]).when).toEqual({ kind: 'all', children: [IS] })
    expect(removeNode(recipeOf(IS), [0]).when).toEqual({ kind: 'all', children: [] })
  })

  it('negates and un-negates a row, never the root', () => {
    const base = recipeOf(IS)
    const negated = negate(base, [0])
    expect(negated.when).toEqual({ kind: 'all', children: [{ kind: 'not', child: IS }] })
    expect(unnegate(negated, [0]).when).toEqual(base.when)
    expect(negate(base, [])).toBe(base)
  })

  it('flips a block between ALL and ANY and dissolves it into its parent', () => {
    const nested = recipeOf(IS, { kind: 'all', children: [BECOMES, MANUAL] })
    expect(setContainerKind(nested, [1], 'any').when).toMatchObject({
      children: [IS, { kind: 'any' }],
    })
    expect(ungroup(nested, [1]).when).toEqual({ kind: 'all', children: [IS, BECOMES, MANUAL] })
  })

  it('keeps the device field when a row switches between is and becomes', () => {
    expect(convertLeafKind(IS, 'device-becomes')).toEqual(BECOMES)
    expect(convertLeafKind(BECOMES, 'device-is')).toEqual(IS)
    expect(convertLeafKind(IS, 'manual')).toEqual({ kind: 'manual' })
  })

  it('blames two events under ALL on that ALL, not on the root', () => {
    const tree = recipeOf(IS, {
      kind: 'all',
      children: [BECOMES, { kind: 'manual' }],
    })
    const issues = whenIssues(tree.when)
    expect([...issues.keys()]).toEqual([pathKey([1])])
    expect(issues.get('when.1')).toBeTruthy()
    expect(whenIssues(recipeOf(IS, { kind: 'any', children: [BECOMES, MANUAL] }).when).size).toBe(0)
  })

  it('stops offering a nested block once the depth limit would be crossed', () => {
    const shallow = recipeOf(IS)
    expect(canNestBlockAt(shallow, [])).toBe(true)
    const deep = recipeOf({
      kind: 'any',
      children: [{ kind: 'all', children: [IS] }],
    })
    expect(canNestBlockAt(deep, [0])).toBe(true)
    expect(canNestBlockAt(deep, [0, 0])).toBe(false)
    expect(whenBudget(deep).depth).toBe(4)
  })
})
