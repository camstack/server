import { describe, expect, it } from 'vitest'
import { buildCandidateTree, flattenCandidateNodes } from '../scan-candidate-tree'
import { checkSubnet } from '../scan-subnet'

const c = (stableId: string, parentStableId?: string) => ({
  stableId,
  parentStableId,
})

describe('buildCandidateTree', () => {
  it('nests two children under their gateway as one group', () => {
    const tree = buildCandidateTree([c('gw'), c('a', 'gw'), c('b', 'gw')])
    expect(tree).toHaveLength(1)
    expect(tree[0]?.candidate.stableId).toBe('gw')
    expect(tree[0]?.children.map((n) => n.candidate.stableId)).toEqual(['a', 'b'])
  })

  it('keeps a child whose gateway is absent at the top level', () => {
    const tree = buildCandidateTree([c('a', 'missing'), c('board')])
    expect(tree.map((n) => n.candidate.stableId)).toEqual(['a', 'board'])
    expect(tree.every((n) => n.children.length === 0)).toBe(true)
  })

  it('does not lose members of a parent loop', () => {
    const tree = buildCandidateTree([c('x', 'y'), c('y', 'x')])
    expect(
      flattenCandidateNodes(tree)
        .map((n) => n.stableId)
        .sort(),
    ).toEqual(['x', 'y'])
  })
})

describe('checkSubnet', () => {
  it('accepts a CIDR and normalises it', () => {
    expect(checkSubnet(' 192.0.2.0/24 ')).toEqual({
      ok: true,
      cidr: '192.0.2.0/24',
    })
  })
  it('rejects typos and ranges the server would refuse', () => {
    expect(checkSubnet('192.0.2.0')).toEqual({ ok: false, reason: 'format' })
    expect(checkSubnet('192.0.2.300/24')).toEqual({
      ok: false,
      reason: 'format',
    })
    expect(checkSubnet('10.0.0.0/16')).toEqual({ ok: false, reason: 'prefix' })
  })
})
