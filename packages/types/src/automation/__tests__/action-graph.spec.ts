import { describe, expect, it } from 'vitest'
import {
  ACTION_CALL_DEPTH_MAX,
  NO_RUN_CHAIN,
  actionIdsCalledBy,
  chainWith,
  findActionCycle,
  refuseRunUnder,
  type StoredActionStepsOf,
} from '../action-graph.js'
import type { ActionStep } from '../recipe.js'

const call = (actionId: string) => ({ kind: 'action', actionId }) as const

function graph(edges: Record<string, readonly string[]>): StoredActionStepsOf {
  return async (id) => (id in edges ? (edges[id] ?? []).map(call) : undefined)
}

describe('actionIdsCalledBy', () => {
  it('finds calls nested in choose, parallel, repeat and else, once each', () => {
    const steps: ActionStep[] = [
      call('a'),
      { kind: 'parallel', steps: [call('b'), call('a')] },
      {
        kind: 'choose',
        branches: [{ if: { kind: 'all', children: [] }, steps: [call('c')] }],
        else: [call('d')],
      },
    ]
    expect(actionIdsCalledBy(steps)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('findActionCycle', () => {
  it('refuses a save that closes a cycle and names the path', async () => {
    const stored = graph({ b: ['c'], c: ['a'] })
    expect(await findActionCycle('a', [call('b')], stored)).toEqual(['a', 'b', 'c', 'a'])
  })

  it('refuses an Action that calls itself', async () => {
    expect(await findActionCycle('a', [call('a')], graph({}))).toEqual(['a', 'a'])
  })

  it('accepts a diamond and an id that is not stored', async () => {
    const stored = graph({ b: ['d'], c: ['d'], d: [] })
    expect(await findActionCycle('a', [call('b'), call('c'), call('ghost')], stored)).toBeNull()
  })

  it('terminates on a stored cycle that does not involve the root', async () => {
    const stored = graph({ b: ['c'], c: ['b'] })
    expect(await findActionCycle('a', [call('b')], stored)).toBeNull()
  })
})

describe('refuseRunUnder', () => {
  it('refuses an Action already running above', () => {
    const chain = chainWith(chainWith(NO_RUN_CHAIN, 'a'), 'b')
    expect(refuseRunUnder(chain, 'a')).toContain('a -> b -> a')
    expect(refuseRunUnder(chain, 'c')).toBeNull()
  })

  it('refuses past the depth bound', () => {
    let chain = NO_RUN_CHAIN
    for (let i = 0; i < ACTION_CALL_DEPTH_MAX; i += 1) chain = chainWith(chain, `x${i}`)
    expect(refuseRunUnder(chain, 'next')).toContain('deep')
  })
})
