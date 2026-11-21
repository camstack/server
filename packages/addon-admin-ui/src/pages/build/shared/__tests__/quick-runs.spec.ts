import type { AutomationRunTrace } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { actionDeviceIds } from '../action-devices'
import { QUICK_RUN_LIMIT, quickRunRows, runDurationParts, runEditorPath } from '../quick-runs'

function trace(id: number, patch: Partial<AutomationRunTrace> = {}): AutomationRunTrace {
  return {
    runId: `r${String(id)}`,
    startedAt: id * 1000,
    endedAt: id * 1000 + 2500,
    trigger: { kind: 'detection', outcome: 'pass', reason: `seen ${String(id)}`, vars: {} },
    conditions: [],
    steps: [],
    outcome: 'ran',
    repeat: 1,
    lastAt: id * 1000 + 2500,
    ...patch,
  }
}

describe('quickRunRows', () => {
  it('is newest first and bounded to the glance size', () => {
    const traces = Array.from({ length: 8 }, (_, i) => trace(i + 1))
    const rows = quickRunRows(traces)
    expect(rows).toHaveLength(QUICK_RUN_LIMIT)
    expect(rows.map((r) => r.runId)).toEqual(['r8', 'r7', 'r6', 'r5', 'r4'])
  })

  it('carries outcome, duration and the one-line reason of the Runs panel', () => {
    const [row] = quickRunRows([
      trace(1, {
        outcome: 'failed',
        steps: [{ path: 'actions.0', kind: 'cap', outcome: 'error', message: 'Feeder offline' }],
      }),
    ])
    expect(row?.outcome).toBe('failed')
    expect(row?.durationMs).toBe(2500)
    expect(row?.reason).toBe('Feeder offline')
  })
})

describe('runDurationParts', () => {
  it('names sub-second, seconds and minutes', () => {
    expect(runDurationParts(400).unit).toBe('subSecond')
    expect(runDurationParts(4200)).toMatchObject({ unit: 'seconds', seconds: 4.2 })
    expect(runDurationParts(185_000)).toMatchObject({ unit: 'minutes', minutes: 3, seconds: 5 })
  })
})

describe('runEditorPath', () => {
  it('opens the item on its run', () => {
    expect(runEditorPath('automations', 'block', 'a b', 'r1')).toBe(
      '/build?tab=automations&block=a+b&run=r1',
    )
  })
})

describe('actionDeviceIds', () => {
  it('collects named devices through nested steps, once each, and ignores other targets', () => {
    const steps = [
      { kind: 'cap', target: { kind: 'devices', ids: [3, 4] } },
      {
        kind: 'if',
        steps: [{ kind: 'cap', target: { kind: 'devices', ids: [4, 9] } }],
        else: [{ kind: 'cap', target: { kind: 'room', ids: [77] } }],
      },
      {
        kind: 'parallel',
        branches: [{ steps: [{ kind: 'cap', target: { kind: 'devices', ids: [12] } }] }],
      },
    ]
    expect(actionDeviceIds(steps)).toEqual([3, 4, 9, 12])
  })

  it('names none for steps it cannot read', () => {
    expect(actionDeviceIds([42])).toEqual([])
  })
})
