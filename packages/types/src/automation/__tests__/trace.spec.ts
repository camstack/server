import { describe, expect, it } from 'vitest'
import type { AutomationRunTrace } from '../trace.js'
import {
  appendTrace,
  AutomationRunTraceSchema,
  AutomationStateDocSchema,
  AutomationStepTraceSchema,
  buildTriggerTrace,
} from '../trace.js'

function trace(over: Partial<AutomationRunTrace> & { id: string }): AutomationRunTrace {
  const { id, ...rest } = over
  return {
    runId: id,
    startedAt: 1,
    endedAt: 1,
    trigger: buildTriggerTrace({ kind: 'interval', at: 1 }, 'pass', 'fired'),
    conditions: [],
    steps: [],
    outcome: 'ran',
    repeat: 1,
    lastAt: 1,
    ...rest,
  }
}

const skip = (id: string, at: number, reason = 'x'): AutomationRunTrace =>
  trace({
    id,
    outcome: 'skipped-conditions',
    startedAt: at,
    endedAt: at,
    lastAt: at,
    conditions: [{ path: 'conditions.0', kind: 'condition', outcome: 'fail', reason }],
  })

describe('the trace shapes', () => {
  it('a full trace round-trips through the schema', () => {
    const full = trace({
      id: 'r1',
      trigger: buildTriggerTrace(
        { kind: 'detection', at: 5, deviceId: 7, className: 'dog', trackId: 't', score: 0.9 },
        'pass',
        'dog 0.9 on device 7',
      ),
      verdict: { mode: { mode: 'cooldown', minutes: 30 }, decision: 'bypass', reason: 'manual' },
      steps: [
        { path: 'actions.0', kind: 'cap', cap: 'siren', method: 'on', deviceId: 7, outcome: 'ok' },
        { path: 'actions.1', kind: 'wait', outcome: 'not-run', message: 'an earlier step failed' },
      ],
    })
    expect(AutomationRunTraceSchema.parse(full)).toEqual(full)
    expect(full.trigger.vars).toEqual({ deviceId: 7, className: 'dog', trackId: 't', score: 0.9 })
    expect(AutomationStateDocSchema.parse({ version: 1, lastRunStartedAt: null, traces: [full] }))
  })

  it('the step shape carries no automation vocabulary, so an Action run reuses it', () => {
    expect(
      AutomationStepTraceSchema.safeParse({
        path: 'steps.0',
        kind: 'cap',
        outcome: 'error',
        message: 'boom',
      }).success,
    ).toBe(true)
  })
})

describe('the ring', () => {
  it('keeps the last N, oldest out', () => {
    let ring: AutomationRunTrace[] = []
    for (let i = 0; i < 25; i += 1) ring = appendTrace(ring, trace({ id: `r${i}` }), 20)
    expect(ring).toHaveLength(20)
    expect(ring[0]?.runId).toBe('r5')
  })

  it('collapses identical consecutive skips into a repeat count', () => {
    let ring: AutomationRunTrace[] = [trace({ id: 'run' })]
    ring = appendTrace(ring, skip('s1', 10, 'score 0.41 < 0.6'), 20)
    ring = appendTrace(ring, skip('s2', 20, 'score 0.43 < 0.6'), 20)
    ring = appendTrace(ring, skip('s3', 30, 'score 0.45 < 0.6'), 20)
    expect(ring).toHaveLength(2)
    expect(ring[1]).toMatchObject({ runId: 's1', repeat: 3, lastAt: 30 })
  })

  it('does not collapse skips for a different cause, or across a real run', () => {
    let ring: AutomationRunTrace[] = []
    ring = appendTrace(ring, skip('s1', 1, 'a'), 20)
    ring = appendTrace(ring, trace({ id: 'run' }), 20)
    ring = appendTrace(ring, skip('s2', 2, 'a'), 20)
    expect(ring.map((t) => t.runId)).toEqual(['s1', 'run', 's2'])
  })

  it('evicts the oldest SKIP before any run, so noise cannot flush runs', () => {
    let ring: AutomationRunTrace[] = [
      trace({ id: 'run1' }),
      skip('s1', 1, 'a'),
      trace({ id: 'run2' }),
    ]
    ring = appendTrace(ring, trace({ id: 'run3' }), 3)
    expect(ring.map((t) => t.runId)).toEqual(['run1', 'run2', 'run3'])
  })
})
