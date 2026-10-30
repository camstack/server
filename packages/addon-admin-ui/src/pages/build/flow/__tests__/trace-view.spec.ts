import type { AutomationRunTrace } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { stepToneAt, traceDetails, traceView, whenOutcomes } from '../trace-view'

const BASE: AutomationRunTrace = {
  runId: 'r1',
  startedAt: 1,
  endedAt: 2,
  trigger: { kind: 'detection', outcome: 'pass', reason: 'animal seen', vars: {} },
  conditions: [],
  steps: [],
  outcome: 'ran',
  repeat: 1,
  lastAt: 2,
}

describe('traceView', () => {
  it('paints a clean run green end to end', () => {
    const view = traceView({
      ...BASE,
      steps: [{ path: 'actions.0', kind: 'action', outcome: 'ok' }],
    })
    expect(view.when).toEqual({ tone: 'pass', reason: 'animal seen' })
    expect(view.thenBlock.tone).toBe('pass')
    expect(stepToneAt(view, 0)).toBe('pass')
  })

  it('paints the When block red with the tree reason when the tree refused a fired event', () => {
    const view = traceView({
      ...BASE,
      outcome: 'skipped-conditions',
      conditions: [
        { path: 'when', kind: 'all', outcome: 'fail', reason: 'when.1 failed -> fail' },
        { path: 'when.1', kind: 'device-is', outcome: 'fail', reason: 'door is open' },
      ],
    })
    expect(view.when).toEqual({ tone: 'fail', reason: 'when.1 failed -> fail' })
    expect(view.thenBlock.tone).toBe('idle')
  })

  it('a legacy trace without a when node falls back to the trigger tone', () => {
    const view = traceView({
      ...BASE,
      conditions: [{ path: 'conditions', kind: 'all', outcome: 'fail', reason: 'old' }],
    })
    expect(view.when).toEqual({ tone: 'pass', reason: 'animal seen' })
  })

  it('names the failing step and greys the ones after it', () => {
    const view = traceView({
      ...BASE,
      outcome: 'failed',
      steps: [
        { path: 'actions.0', kind: 'cap', outcome: 'error', message: 'Feeder offline' },
        { path: 'actions.1', kind: 'wait', outcome: 'not-run' },
      ],
    })
    expect(view.thenBlock).toEqual({ tone: 'fail', reason: 'Feeder offline' })
    expect(stepToneAt(view, 0)).toBe('fail')
    expect(stepToneAt(view, 1)).toBe('idle')
  })

  it('reads a run the mode refused as grey, with the verdict as the reason', () => {
    const view = traceView({
      ...BASE,
      outcome: 'skipped-cooldown',
      verdict: {
        mode: { mode: 'cooldown', minutes: 60 },
        decision: 'cooldown',
        reason: 'ran 30 min ago',
      },
    })
    expect(view.thenBlock).toEqual({ tone: 'idle', reason: 'ran 30 min ago' })
  })

  it('a failed trigger is red and nothing after it was reached', () => {
    const view = traceView({
      ...BASE,
      outcome: 'skipped-trigger',
      trigger: { kind: 'detection', outcome: 'fail', reason: 'score 0.4 below 0.6', vars: {} },
      conditions: [{ path: 'when', kind: 'all', outcome: 'not-evaluated', reason: '' }],
    })
    expect(view.when.tone).toBe('fail')
    expect(view.thenBlock.tone).toBe('idle')
  })
})

describe('traceDetails', () => {
  it('carries the trigger vars, expected against observed, and the step outcomes', () => {
    const details = traceDetails({
      ...BASE,
      trigger: {
        kind: 'detection',
        outcome: 'pass',
        reason: 'animal seen',
        vars: { deviceId: 101, className: 'animal', zones: ['bowl', 'door'], armed: false },
      },
      conditions: [
        { path: 'when', kind: 'all', outcome: 'pass', reason: 'all hold' },
        {
          path: 'when.0',
          kind: 'device-is',
          outcome: 'pass',
          reason: '',
          cap: 'pet-feeder',
          fieldPath: 'hopperLevel',
          operator: 'gt',
          deviceId: 201,
          expected: 10,
          observed: 64,
        },
      ],
      steps: [
        {
          path: 'actions.0',
          kind: 'action',
          outcome: 'error',
          message: 'Feeder offline',
          args: { grams: 30, label: 'dog' },
        },
      ],
    })
    expect(details.vars).toEqual([
      { name: 'deviceId', value: { kind: 'value', text: '101' } },
      { name: 'className', value: { kind: 'value', text: 'animal' } },
      { name: 'zones', value: { kind: 'value', text: 'bowl, door' } },
      { name: 'armed', value: { kind: 'value', text: 'false' } },
    ])
    expect(details.conditions[0]?.expected).toBeNull()
    expect(details.conditions[1]).toMatchObject({
      depth: 1,
      subject: 'pet-feeder.hopperLevel',
      operator: 'gt',
      expected: { kind: 'value', text: '10' },
      observed: { kind: 'value', text: '64' },
    })
    expect(details.steps).toEqual([
      {
        index: 0,
        kind: 'action',
        tone: 'fail',
        message: 'Feeder offline',
        args: [
          { name: 'grams', value: { kind: 'value', text: '30' } },
          { name: 'label', value: { kind: 'value', text: 'dog' } },
        ],
      },
    ])
  })

  it('shows a reading the mirror never held as unknown, never as 0 or empty', () => {
    const details = traceDetails({
      ...BASE,
      conditions: [
        {
          path: 'when.0',
          kind: 'device-is',
          outcome: 'fail',
          reason: 'unknown',
          expected: 0,
          observed: null,
        },
        { path: 'when.1', kind: 'device-is', outcome: 'not-evaluated', reason: '' },
      ],
    })
    expect(details.conditions[0]?.observed).toEqual({ kind: 'unknown' })
    expect(details.conditions[0]?.expected).toEqual({ kind: 'value', text: '0' })
    // Not recorded is a different thing from unknown.
    expect(details.conditions[1]?.observed).toBeNull()
  })
})

describe('whenOutcomes', () => {
  it('maps every when path to its outcome', () => {
    const map = whenOutcomes({
      ...BASE,
      conditions: [
        { path: 'when', kind: 'all', outcome: 'fail', reason: '' },
        { path: 'when.0.1', kind: 'device-is', outcome: 'pass', reason: '' },
      ],
    })
    expect(map.get('when')).toBe('fail')
    expect(map.get('when.0.1')).toBe('pass')
    expect(map.get('when.2')).toBeUndefined()
  })
})
