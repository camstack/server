import { describe, expect, it } from 'vitest'
import { type AgentMaxCameras, bulkSetPlan, summarizeMaxCameras } from '../max-cameras'

const rows = (...pairs: readonly [string, number | null][]): readonly AgentMaxCameras[] =>
  pairs.map(([agentNodeId, maxCameras]) => ({ agentNodeId, maxCameras }))

describe('summarizeMaxCameras', () => {
  it('reports empty for no settings', () => {
    expect(summarizeMaxCameras([])).toEqual({ kind: 'empty' })
  })

  it('reports uniform null when every node is unlimited', () => {
    expect(summarizeMaxCameras(rows(['hub', null], ['mac', null]))).toEqual({
      kind: 'uniform',
      value: null,
    })
  })

  it('reports uniform value when every node shares the same cap', () => {
    expect(summarizeMaxCameras(rows(['hub', 8], ['mac', 8]))).toEqual({
      kind: 'uniform',
      value: 8,
    })
  })

  it('reports mixed with per-node values when caps differ', () => {
    const s = rows(['hub', 8], ['mac', null])
    expect(summarizeMaxCameras(s)).toEqual({ kind: 'mixed', perNode: s })
  })

  it('treats a single node as uniform', () => {
    expect(summarizeMaxCameras(rows(['hub', 4]))).toEqual({ kind: 'uniform', value: 4 })
  })
})

describe('bulkSetPlan', () => {
  it('returns empty when every node already matches the target', () => {
    expect(bulkSetPlan(rows(['hub', 8], ['mac', 8]), ['hub', 'mac'], 8)).toEqual([])
  })

  it('includes only nodes whose current value differs from the target', () => {
    expect(bulkSetPlan(rows(['hub', 8], ['mac', 4]), ['hub', 'mac'], 8)).toEqual(['mac'])
  })

  it('includes topology nodes missing from settings when target is non-null (current = null)', () => {
    expect(bulkSetPlan(rows(['hub', 8]), ['hub', 'mac'], 8)).toEqual(['mac'])
  })

  it('treats a missing settings row as null so a null target skips it', () => {
    expect(bulkSetPlan(rows(['hub', 8]), ['hub', 'mac'], null)).toEqual(['hub'])
  })

  it('skips nodes already at null when target is null', () => {
    expect(bulkSetPlan(rows(['hub', null], ['mac', null]), ['hub', 'mac'], null)).toEqual([])
  })

  it('preserves allNodeIds order and does not include unknown settings nodes', () => {
    // `mystery` has a settings row but is not in topology → excluded (offline).
    expect(bulkSetPlan(rows(['mac', 2], ['mystery', 9]), ['hub', 'mac'], 5)).toEqual(['hub', 'mac'])
  })
})
