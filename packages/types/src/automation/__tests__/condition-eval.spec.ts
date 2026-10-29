import { describe, expect, it } from 'vitest'
import { collectMirrorSources, ConditionMirror, evaluateConditionTree } from '../condition-eval.js'
import type { AutomationCondition } from '../recipe.js'

const leaf = (
  deviceId: number,
  fieldPath: string,
  operator: 'eq' | 'gte',
  value: number | string,
): AutomationCondition => ({
  kind: 'condition',
  deviceId,
  cap: 'sensor',
  fieldPath,
  operator,
  value,
})

function mirrorWith(cond: AutomationCondition, slices: Record<number, object>): ConditionMirror {
  const m = new ConditionMirror(collectMirrorSources(cond))
  for (const [id, slice] of Object.entries(slices)) m.apply(Number(id), 'sensor', slice)
  return m
}

describe('the traced evaluation', () => {
  const tree: AutomationCondition = {
    kind: 'all',
    children: [leaf(1, 'tank', 'gte', 1), leaf(2, 'bowl', 'gte', 5), leaf(3, 'x', 'eq', 'y')],
  }

  it('gives every node a path, an outcome and a reason, and marks the short-circuited tail', () => {
    const m = mirrorWith(tree, { 1: { tank: 3 }, 2: { bowl: 0 }, 3: { x: 'y' } })
    const r = evaluateConditionTree(tree, m, 0)
    expect(r.pass).toBe(false)
    expect(r.nodes.map((n) => [n.path, n.outcome])).toEqual([
      ['conditions', 'fail'],
      ['conditions.0', 'pass'],
      ['conditions.1', 'fail'],
      ['conditions.2', 'not-evaluated'],
    ])
    expect(r.nodes[1]?.reason).toBe('tank 3, expected ≥ 1 → pass')
    expect(r.nodes[2]?.reason).toBe('bowl 0, expected ≥ 5 → fail')
    expect(r.nodes[2]?.observed).toBe(0)
    expect(r.nodes[3]?.reason).toContain('short-circuited by conditions.1')
  })

  it('ANY short-circuits on the first pass; NOT inverts its child', () => {
    const any: AutomationCondition = {
      kind: 'any',
      children: [leaf(1, 'tank', 'gte', 1), leaf(2, 'bowl', 'gte', 5)],
    }
    const m = mirrorWith(any, { 1: { tank: 3 }, 2: { bowl: 0 } })
    expect(evaluateConditionTree(any, m, 0).nodes.map((n) => n.outcome)).toEqual([
      'pass',
      'pass',
      'not-evaluated',
    ])
    const not: AutomationCondition = { kind: 'not', child: leaf(1, 'tank', 'gte', 9) }
    const r = evaluateConditionTree(not, m, 0)
    expect(r.pass).toBe(true)
    expect(r.nodes.map((n) => [n.path, n.outcome])).toEqual([
      ['conditions', 'pass'],
      ['conditions.0', 'fail'],
    ])
  })

  it('an unknown value is false with a reason, never a throw and never true', () => {
    const l = leaf(1, 'tank', 'gte', 1)
    const r = evaluateConditionTree(l, mirrorWith(l, {}), 0)
    expect(r.pass).toBe(false)
    expect(r.nodes[0]?.reason).toBe('tank value unknown → fail')
    expect(r.nodes[0]?.observed).toBeNull()
  })

  it('no condition tree passes with no nodes', () => {
    expect(evaluateConditionTree(undefined, new ConditionMirror([]), 0)).toEqual({
      pass: true,
      nodes: [],
    })
  })

  it('evaluates an expression leaf over a global binding held by the mirror', () => {
    const expr: AutomationCondition = {
      kind: 'expression',
      expr: 'outdoor < 5',
      bindings: {
        outdoor: { kind: 'global', sourceStableId: 'ha:out', cap: 'sensor', fieldPath: 'value' },
      },
    }
    const m = new ConditionMirror(collectMirrorSources(expr))
    expect(evaluateConditionTree(expr, m, 0).nodes[0]?.reason).toBe('outdoor value unknown → fail')
  })
})

describe('the mirror', () => {
  const l = leaf(1, 'tank', 'gte', 1)

  it('refresh fills it; a failed read keeps the previous value (D49)', async () => {
    const m = new ConditionMirror(collectMirrorSources(l))
    const ok = await m.refresh({
      fetchSlice: async () => ({ tank: 3 }),
      fetchStableIds: async () => new Map(),
    })
    expect(ok.updated).toBe(1)
    expect(m.read(1, 'sensor', 'tank')).toBe(3)
    const failed = await m.refresh({
      fetchSlice: async () => {
        throw new Error('hub busy')
      },
      fetchStableIds: async () => new Map(),
    })
    expect(failed.kept).toBe(1)
    expect(m.read(1, 'sensor', 'tank')).toBe(3)
    await m.refresh({ fetchSlice: async () => undefined, fetchStableIds: async () => new Map() })
    expect(m.read(1, 'sensor', 'tank')).toBe(3)
  })

  it('a state-changed event updates a watched slice and ignores one nobody reads', () => {
    const m = new ConditionMirror(collectMirrorSources(l))
    m.apply(1, 'sensor', { tank: 0 })
    m.apply(2, 'sensor', { tank: 9 })
    expect(m.read(1, 'sensor', 'tank')).toBe(0)
    expect(m.read(2, 'sensor', 'tank')).toBeUndefined()
  })
})

describe('a leaf that was never normalised', () => {
  it('fails with a reason instead of comparing against the { value, unit } pair', () => {
    const raw: AutomationCondition = {
      kind: 'condition',
      deviceId: 1,
      cap: 'sensor',
      fieldPath: 'bowl',
      operator: 'ne',
      value: { value: 10, unit: 'g' },
    }
    const m = mirrorWith(raw, { 1: { bowl: 0.01 } })
    const r = evaluateConditionTree(raw, m, 0)
    expect(r.pass).toBe(false)
    expect(r.nodes[0]?.reason).toContain('unit was never converted')
  })
})
