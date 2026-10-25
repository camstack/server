/**
 * The one-line summary of a collapsed Consumables section, and the rule that
 * decides whether it starts open: open when ANY item needs attention (low,
 * empty, a full waste tank, a part to replace), closed when every item is ok
 * or unknown. Unknown is never counted as ok (D393).
 */
import type { ConsumableItem } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { summarizeConsumables } from '../consumables-summary'

function item(over: Partial<ConsumableItem> & Pick<ConsumableItem, 'key'>): ConsumableItem {
  return {
    label: over.key,
    level: null,
    status: null,
    lastResetAt: null,
    resettable: false,
    ...over,
  }
}

describe('summarizeConsumables', () => {
  it('nothing reported is its own state, and starts closed', () => {
    expect(summarizeConsumables([])).toEqual({ kind: 'none', needsAttention: false })
  })

  it('every item known ok → all ok, closed', () => {
    const s = summarizeConsumables([
      item({ key: 'salt', kind: 'supply', status: 'ok' }),
      item({ key: 'filter', level: 80 }),
    ])
    expect(s).toEqual({ kind: 'ok', needsAttention: false, count: 2 })
  })

  it('ok + unknown is NOT "all ok": it says how many are unknown, and stays closed', () => {
    const s = summarizeConsumables([
      item({ key: 'salt', kind: 'supply', status: 'ok' }),
      item({ key: 'mystery' }),
    ])
    expect(s).toEqual({ kind: 'partial', needsAttention: false, ok: 1, unknown: 1 })
  })

  it('one supply low → that item named, open', () => {
    const s = summarizeConsumables([
      item({ key: 'salt', label: 'Salt', kind: 'supply', status: 'low' }),
      item({ key: 'rinse', label: 'Rinse aid', kind: 'supply', status: 'ok' }),
    ])
    expect(s).toMatchObject({
      kind: 'attention',
      needsAttention: true,
      count: 1,
      worst: { label: 'Salt', level: 'low', replace: false },
    })
  })

  it('a full waste tank and a part to replace both need attention', () => {
    expect(
      summarizeConsumables([item({ key: 'bin', kind: 'waste', status: 'full' })]).needsAttention,
    ).toBe(true)
    const replace = summarizeConsumables([
      item({ key: 'brush', label: 'Brush', status: 'replace' }),
    ])
    expect(replace).toMatchObject({
      kind: 'attention',
      worst: { label: 'Brush', replace: true },
    })
  })

  it('several → the count, and the WORST item first (empty over full over low)', () => {
    const s = summarizeConsumables([
      item({ key: 'filter', label: 'Filter', level: 10 }),
      item({ key: 'bin', label: 'Dust bin', kind: 'waste', level: 95 }),
      item({ key: 'water', label: 'Clean water', kind: 'supply', level: 0 }),
    ])
    expect(s).toMatchObject({
      kind: 'attention',
      count: 3,
      worst: { label: 'Clean water', level: 'empty' },
    })
  })
})
