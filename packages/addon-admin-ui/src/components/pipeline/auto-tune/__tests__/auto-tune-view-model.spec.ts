/**
 * D745 — the Auto tune plan as operator text.
 */
import type { AutoTunePlan } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { latencySourceText, planCounts, planIsNoop, reasonText } from '../auto-tune-view-model'

const EMPTY: AutoTunePlan = {
  planHash: 'h',
  family: 'yolov9',
  headroom: 0.4,
  minSessionsPerDevice: 2,
  cameraFps: 10,
  generatedAt: 0,
  nodes: [],
  nodeChanges: [],
  warnings: [],
}

describe('auto tune view model', () => {
  it('a plan with nothing to write is a no-op (Apply is disabled)', () => {
    expect(planIsNoop(EMPTY)).toBe(true)
    expect(
      planIsNoop({
        ...EMPTY,
        nodeChanges: [
          {
            nodeId: 'hub',
            deviceKey: 'openvino:npu',
            madeExplicit: false,
            modelPins: [],
            thresholds: [{ stepId: 'object-detection', keys: ['minConfidencePerson'] }],
          },
        ],
      }),
    ).toBe(false)
  })

  it('counts only accelerator writes — a camera carries no model (D927)', () => {
    expect(planCounts(EMPTY)).toEqual({ modelChanges: 0, thresholdClears: 0 })
  })

  it('says the capacity against the floor, never a load', () => {
    expect(reasonText({ kind: 'capacity', sessions: 3, minSessions: 2 })).toBe(
      'Capacity 3 sessions ≥ min 2.',
    )
    expect(reasonText({ kind: 'no-fit-lightest', sessions: 1, minSessions: 2 })).toBe(
      'No model reaches 2 sessions per device; the one with the most capacity (1 session) is used.',
    )
    expect(reasonText({ kind: 'node-offline' })).toBe('Node offline: nothing on it will change.')
  })
})

describe('latencySourceText (D791)', () => {
  it('says the speed was measured on the node, or that it comes from the table', () => {
    expect(
      latencySourceText(
        { kind: 'node-benchmark', resultId: 'bench', measuredAtMs: Date.UTC(2026, 9, 8) },
        'en-GB',
      ),
    ).toBe('measured on this node, 8 Oct')
    expect(latencySourceText({ kind: 'table' })).toContain('latency table')
    expect(latencySourceText(undefined)).toContain('latency table')
    expect(latencySourceText({ kind: 'estimated', estimatedFrom: 'intel-n-series' })).toBe(
      'estimated from Intel N-series — benchmark this node to measure it',
    )
  })
})
