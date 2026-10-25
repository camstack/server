import { describe, expect, it } from 'vitest'
import {
  DECODE_BUDGET_MAX_MB,
  DECODE_BUDGET_MIN_MB,
  derivedDecodeBudgetMb,
  resolveNodeDecodeLimits,
} from '../node-decode-budget.js'

const BASE = {
  clusterBudgetMb: 8192,
  clusterMaxWorkers: 8,
  defaultBudgetMb: 8192,
  defaultMaxWorkers: 8,
}

describe('resolveNodeDecodeLimits — one number per NODE, not per cluster', () => {
  it("a 16 GB Mac on the shipped defaults gets half its RAM, not the hub's 8192", () => {
    const r = resolveNodeDecodeLimits({ ...BASE, node: {}, totalMemMb: 16_384 })
    expect(r).toEqual({
      budgetMb: 8192,
      budgetSource: 'derived',
      maxWorkers: 8,
      maxWorkersSource: 'cluster',
    })
    const hub = resolveNodeDecodeLimits({ ...BASE, node: {}, totalMemMb: 65_536 })
    expect(hub.budgetMb).toBe(DECODE_BUDGET_MAX_MB)
    expect(hub.budgetSource).toBe('derived')
  })

  it('the derivation is clamped — a tiny node still decodes, a huge one does not get everything', () => {
    expect(derivedDecodeBudgetMb(2_048)).toBe(DECODE_BUDGET_MIN_MB)
    expect(derivedDecodeBudgetMb(262_144)).toBe(DECODE_BUDGET_MAX_MB)
    expect(derivedDecodeBudgetMb(8_192)).toBe(4_096)
  })

  it('a cluster value the operator MOVED wins over the derivation, on every node', () => {
    const r = resolveNodeDecodeLimits({
      ...BASE,
      clusterBudgetMb: 6000,
      node: {},
      totalMemMb: 65_536,
    })
    expect(r.budgetMb).toBe(6000)
    expect(r.budgetSource).toBe('cluster')
  })

  it("the node's own setting wins over both, for the budget and for the worker cap", () => {
    const r = resolveNodeDecodeLimits({
      ...BASE,
      clusterBudgetMb: 6000,
      node: { decodeBudgetMb: 5000, maxLiveDecodeWorkers: 5 },
      totalMemMb: 16_384,
    })
    expect(r).toEqual({
      budgetMb: 5000,
      budgetSource: 'node',
      maxWorkers: 5,
      maxWorkersSource: 'node',
    })
  })
})
