import type { AutomationRunTrace } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  runSummary,
  stepToneAt,
  traceDetails,
  traceView,
  valueInUnit,
  whenRunView,
} from '../trace-view'

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

describe('a step that failed and was passed over (#500)', () => {
  it('is red with its message, and the run stays green', () => {
    const trace: AutomationRunTrace = {
      ...BASE,
      steps: [
        { path: 'actions.0', kind: 'cap', outcome: 'failed-continued', message: 'device refused' },
        { path: 'actions.1', kind: 'cap', outcome: 'ok' },
      ],
    }
    const view = traceView(trace)
    expect(stepToneAt(view, 0)).toBe('fail')
    expect(stepToneAt(view, 1)).toBe('pass')
    expect(view.thenBlock.tone).toBe('pass')
    expect(traceDetails(trace).steps[0]).toMatchObject({ tone: 'fail', message: 'device refused' })
  })
})

describe('a wait that ran out and went on (#500)', () => {
  it('is red with its reason, not "not run", and the run stays green', () => {
    const trace: AutomationRunTrace = {
      ...BASE,
      steps: [
        {
          path: 'actions.0',
          kind: 'wait-until',
          outcome: 'timed-out',
          message: 'timed out after 600 s: the door is open',
        },
        { path: 'actions.1', kind: 'cap', outcome: 'ok' },
      ],
    }
    const view = traceView(trace)
    expect(stepToneAt(view, 0)).toBe('fail')
    expect(view.thenBlock.tone).toBe('pass')
    expect(traceDetails(trace).steps[0]?.message).toBe('timed out after 600 s: the door is open')
  })
})

describe('a choose step (#500)', () => {
  it('names the list that ran and carries its steps', () => {
    const trace: AutomationRunTrace = {
      ...BASE,
      steps: [
        {
          path: 'actions.0',
          kind: 'choose',
          outcome: 'ok',
          branch: 'branches.1',
          steps: [
            { path: 'actions.0.branches.1.steps.0', kind: 'wait', outcome: 'ok' },
            {
              path: 'actions.0.branches.1.steps.1',
              kind: 'cap',
              outcome: 'failed-continued',
              message: 'lamp offline',
            },
          ],
        },
        { path: 'actions.1', kind: 'choose', outcome: 'ok', branch: 'else', steps: [] },
        {
          path: 'actions.2',
          kind: 'choose',
          outcome: 'skipped',
          message: 'not run: no branch is true',
        },
      ],
    }
    const [first, second, third] = traceDetails(trace).steps
    expect(first?.chose).toEqual({ kind: 'branch', index: 1 })
    expect(first?.nested).toEqual([
      { kind: 'wait', tone: 'pass', message: null, chose: null, rounds: null, inner: [] },
      { kind: 'cap', tone: 'fail', message: 'lamp offline', chose: null, rounds: null, inner: [] },
    ])
    expect(second?.chose).toEqual({ kind: 'else' })
    expect(third?.chose).toBeNull()
    expect(third?.nested).toEqual([])
  })

  it('a repeat says its nested rows are the last round only (#500)', () => {
    const trace: AutomationRunTrace = {
      ...BASE,
      steps: [
        {
          path: 'actions.0',
          kind: 'repeat',
          outcome: 'timed-out',
          message: 'stopped at 3 iterations',
          iterations: 3,
          steps: [{ path: 'actions.0.steps.0', kind: 'cap', outcome: 'ok' }],
        },
        { path: 'actions.1', kind: 'parallel', outcome: 'ok', steps: [] },
      ],
    }
    const [loop, other] = traceDetails(trace).steps
    expect(loop?.rounds).toBe(3)
    expect(loop?.tone).toBe('fail')
    expect(loop?.nested).toHaveLength(1)
    expect(other?.rounds).toBeNull()
  })

  it('a block step one level down keeps what it chose, its rounds and its own steps', () => {
    const trace: AutomationRunTrace = {
      ...BASE,
      steps: [
        {
          path: 'actions.0',
          kind: 'repeat',
          outcome: 'ok',
          iterations: 2,
          steps: [
            {
              path: 'actions.0.steps.0',
              kind: 'choose',
              outcome: 'ok',
              branch: 'else',
              steps: [
                {
                  path: 'actions.0.steps.0.else.0',
                  kind: 'cap',
                  outcome: 'error',
                  message: 'lamp offline',
                },
              ],
            },
            {
              path: 'actions.0.steps.1',
              kind: 'repeat',
              outcome: 'ok',
              iterations: 4,
              steps: [{ path: 'actions.0.steps.1.steps.0', kind: 'wait', outcome: 'ok' }],
            },
          ],
        },
      ],
    }
    const [loop] = traceDetails(trace).steps
    expect(loop?.nested).toEqual([
      {
        kind: 'choose',
        tone: 'pass',
        message: null,
        chose: { kind: 'else' },
        rounds: null,
        inner: [{ kind: 'cap', tone: 'fail', message: 'lamp offline' }],
      },
      {
        kind: 'repeat',
        tone: 'pass',
        message: null,
        chose: null,
        rounds: 4,
        inner: [{ kind: 'wait', tone: 'pass', message: null }],
      },
    ])
  })
})

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
        devices: [],
        chose: null,
        nested: [],
        rounds: null,
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

describe('whenRunView', () => {
  const run: AutomationRunTrace = {
    ...BASE,
    trigger: {
      ...BASE.trigger,
      path: 'when.0.0',
      vars: { className: 'animal', score: 0.91 },
    },
    conditions: [
      { path: 'when', kind: 'all', outcome: 'fail', reason: '' },
      { path: 'when.0', kind: 'any', outcome: 'pass', reason: '' },
      { path: 'when.0.0', kind: 'detection', outcome: 'pass', reason: 'animal seen' },
      { path: 'when.1', kind: 'device-is', outcome: 'fail', reason: 'weight below 10 g' },
      { path: 'when.2', kind: 'device-is', outcome: 'not-evaluated', reason: '' },
    ],
  }

  it('joins every row AND sub-block to its own node, by path', () => {
    const view = whenRunView(run)
    expect(view.nodes.get('when.0')?.outcome).toBe('pass')
    expect(view.nodes.get('when.1')?.outcome).toBe('fail')
    expect(view.nodes.get('when.2')?.outcome).toBe('not-evaluated')
    expect(view.nodes.get('when.9')).toBeUndefined()
  })

  it('names the row the event fired on and carries the trigger vars', () => {
    const view = whenRunView(run)
    expect(view.triggerPath).toBe('when.0.0')
    expect(view.vars.map((v) => v.name)).toEqual(['className', 'score'])
  })

  it('a trace written before the single tree has no trigger row to attach to', () => {
    const view = whenRunView({ ...run, trigger: { ...run.trigger, path: undefined } })
    expect(view.triggerPath).toBeNull()
  })
})

describe('valueInUnit', () => {
  it('shows a stored base-unit number in the unit the row picked', () => {
    // 0.01 kg stored; the row says "10 g".
    expect(valueInUnit(0.01, 'kg', 'g')).toEqual({ kind: 'value', text: '10 g' })
    expect(valueInUnit(0.04, 'kg', 'g')).toEqual({ kind: 'value', text: '40 g' })
  })

  it('keeps the raw number when the row picked no unit or the units cannot convert', () => {
    expect(valueInUnit(0.04, 'kg', undefined)).toEqual({ kind: 'value', text: '0.04' })
    expect(valueInUnit(5, 'kg', '°C')).toEqual({ kind: 'value', text: '5' })
  })

  it('an unknown reading stays unknown, never 0', () => {
    expect(valueInUnit(null, 'kg', 'g')).toEqual({ kind: 'unknown' })
  })
})

describe('runSummary', () => {
  it('counts the steps that ran and names a failure', () => {
    const summary = runSummary({
      ...BASE,
      outcome: 'failed',
      steps: [
        { path: 'actions.0', kind: 'cap', outcome: 'ok' },
        { path: 'actions.1', kind: 'cap', outcome: 'error', message: 'Feeder offline' },
        { path: 'actions.2', kind: 'wait', outcome: 'not-run' },
      ],
    })
    expect(summary).toEqual({ stepsRun: 1, stepsTotal: 3, reason: 'Feeder offline' })
  })

  it('reads the verdict of a run the mode refused', () => {
    const summary = runSummary({
      ...BASE,
      outcome: 'skipped-cooldown',
      verdict: {
        mode: { mode: 'cooldown', minutes: 60 },
        decision: 'cooldown',
        reason: 'ran 30 min ago',
      },
    })
    expect(summary.reason).toBe('ran 30 min ago')
    expect(summary.stepsTotal).toBe(0)
  })
})

describe('traceDetails steps', () => {
  it('carries the per-device outcome of a step', () => {
    const details = traceDetails({
      ...BASE,
      steps: [
        {
          path: 'actions.0',
          kind: 'cap',
          outcome: 'error',
          devices: [
            { deviceId: 1, outcome: 'ok' },
            { deviceId: 2, outcome: 'error', message: 'offline' },
          ],
        },
      ],
    })
    expect(details.steps[0]?.devices).toEqual([
      { deviceId: 1, tone: 'pass', message: null },
      { deviceId: 2, tone: 'fail', message: 'offline' },
    ])
  })
})
