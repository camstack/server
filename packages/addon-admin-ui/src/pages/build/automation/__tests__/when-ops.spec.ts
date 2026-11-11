import type { AutomationLeaf, AutomationRecipe } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { EMPTY_RECIPE } from '../recipe-parts'
import {
  addNode,
  canNestBlockAt,
  convertLeafKind,
  negate,
  nodeAt,
  removeNode,
  seedBlock,
  setContainerKind,
  unnegate,
  moveNode,
  summarizeWhen,
  swapPathKeys,
  whenBudget,
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
    expect(removeNode(nested, [1, 0]).when).toEqual({
      kind: 'all',
      children: [IS],
    })
    expect(removeNode(recipeOf(IS), [0]).when).toEqual({
      kind: 'all',
      children: [],
    })
  })

  it('negates and un-negates a row, never the root', () => {
    const base = recipeOf(IS)
    const negated = negate(base, [0])
    expect(negated.when).toEqual({
      kind: 'all',
      children: [{ kind: 'not', child: IS }],
    })
    expect(unnegate(negated, [0]).when).toEqual(base.when)
    expect(negate(base, [])).toBe(base)
  })

  it('flips a block between ALL and ANY', () => {
    const nested = recipeOf(IS, { kind: 'all', children: [BECOMES, MANUAL] })
    expect(setContainerKind(nested, [1], 'any').when).toMatchObject({
      children: [IS, { kind: 'any' }],
    })
  })

  it('keeps the device field when a row switches between is and becomes', () => {
    expect(convertLeafKind(IS, 'device-becomes')).toEqual(BECOMES)
    expect(convertLeafKind(BECOMES, 'device-is')).toEqual(IS)
    expect(convertLeafKind(IS, 'manual')).toEqual({ kind: 'manual' })
    // a trigger row keeps its id across a type change, so a row that names it still does
    expect(convertLeafKind({ kind: 'manual', id: 't1' }, 'interval')).toMatchObject({
      kind: 'interval',
      id: 't1',
    })
    expect(convertLeafKind({ kind: 'manual', id: 't1' }, 'time-is')).not.toHaveProperty('id')
  })

  it('moves a row or block one place among its siblings, never past either end', () => {
    const tree = recipeOf(IS, { kind: 'any', children: [BECOMES, MANUAL] }, MANUAL)
    const down = moveNode(tree, [0], 1)
    expect(nodeAt(down.when, [0])?.kind).toBe('any')
    expect(nodeAt(down.when, [1])).toEqual(IS)
    const up = moveNode(tree, [2], -1)
    expect(nodeAt(up.when, [1])).toEqual(MANUAL)
    expect(nodeAt(up.when, [2])?.kind).toBe('any')
    expect(moveNode(tree, [0], -1)).toBe(tree)
    expect(moveNode(tree, [2], 1)).toBe(tree)
    expect(moveNode(tree, [], 1)).toBe(tree)
  })

  it('moves a row inside a nested block without touching the rest', () => {
    const tree = recipeOf(IS, { kind: 'any', children: [BECOMES, MANUAL] })
    const next = moveNode(tree, [1, 1], -1)
    expect(nodeAt(next.when, [1, 0])).toEqual(MANUAL)
    expect(nodeAt(next.when, [1, 1])).toEqual(BECOMES)
    expect(nodeAt(next.when, [0])).toEqual(IS)
  })

  it('summarises a block in one line, nested blocks and NOT included', () => {
    const block = {
      kind: 'all' as const,
      children: [
        IS,
        { kind: 'any' as const, children: [BECOMES, MANUAL] },
        { kind: 'not' as const, child: MANUAL },
      ],
    }
    expect(summarizeWhen(block, (kind) => kind)).toBe(
      'device-is · ANY (device-becomes · manual) · NOT manual',
    )
  })

  it('swaps the remembered keys of two moved siblings, and their subtrees', () => {
    const keys = new Set(['when.0', 'when.0.1', 'when.2'])
    const next = swapPathKeys(keys, [0], [1])
    expect([...next].sort()).toEqual(['when.1', 'when.1.1', 'when.2'])
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
