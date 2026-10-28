import type { AutomationRunTrace } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { stepToneAt, traceView } from '../trace-view'

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
  it('paints a clean run green end to end and leaves a missing If untinted', () => {
    const view = traceView({
      ...BASE,
      steps: [{ path: 'actions.0', kind: 'action', outcome: 'ok' }],
    })
    expect(view.when).toEqual({ tone: 'pass', reason: 'animal seen' })
    expect(view.condition).toBeNull()
    expect(view.thenBlock.tone).toBe('pass')
    expect(stepToneAt(view, 0)).toBe('pass')
  })

  it('paints the condition that stopped the run red and Then grey', () => {
    const view = traceView({
      ...BASE,
      outcome: 'skipped-conditions',
      conditions: [
        { path: 'conditions', kind: 'all', outcome: 'fail', reason: 'conditions.0 failed -> fail' },
        { path: 'conditions.0', kind: 'condition', outcome: 'fail', reason: 'door is open' },
      ],
    })
    expect(view.condition).toEqual({ tone: 'fail', reason: 'conditions.0 failed -> fail' })
    expect(view.thenBlock.tone).toBe('idle')
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
      conditions: [{ path: 'conditions', kind: 'all', outcome: 'not-evaluated', reason: '' }],
    })
    expect(view.when.tone).toBe('fail')
    expect(view.condition).toEqual({ tone: 'idle', reason: null })
    expect(view.thenBlock.tone).toBe('idle')
  })
})
