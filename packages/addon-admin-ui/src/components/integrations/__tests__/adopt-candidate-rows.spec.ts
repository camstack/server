import { describe, it, expect } from 'vitest'
import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'

import { candidateDistinguisher, orderCandidatesAsTree } from '../adopt-candidate-rows'

function cand(
  id: string,
  name: string,
  extra: Partial<DiscoveredChildDevice> = {},
): DiscoveredChildDevice {
  return {
    childNativeId: id,
    name,
    type: DeviceType.Cover,
    status: 'online',
    metadata: {},
    alreadyAdopted: false,
    adoptedDeviceId: null,
    ...extra,
  }
}

describe('orderCandidatesAsTree', () => {
  it('nests a child under its parent and keeps same-named rows apart', () => {
    const gw = cand('gw', 'Hub', { type: DeviceType.Gateway })
    const a = cand('rad:1', 'Shutter', { parentStableId: 'gw', metadata: { model: 'RolloTron' } })
    const b = cand('rad:2', 'Shutter', { parentStableId: 'gw', metadata: { model: 'Gurt' } })
    const other = cand('x', 'Shutter')
    const rows = orderCandidatesAsTree([a, other, gw, b])
    expect(rows.map((r) => [r.candidate.childNativeId, r.depth])).toEqual([
      ['x', 0],
      ['gw', 0],
      ['rad:1', 1],
      ['rad:2', 1],
    ])
    expect(candidateDistinguisher(a)).not.toEqual(candidateDistinguisher(b))
  })
})

describe('candidateDistinguisher', () => {
  it('joins model and the native id tail', () => {
    expect(
      candidateDistinguisher(cand('rademacher:i1:cover:77', 'S', { metadata: { model: 'M1' } })),
    ).toBe('M1 · 77')
  })
  it('is empty when nothing distinguishes', () => {
    expect(candidateDistinguisher(cand('', 'S'))).toBe('')
  })
})
