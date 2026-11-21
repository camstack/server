import { describe, expect, it } from 'vitest'
import type { ActionStep } from '../../automation/recipe.js'
import { actionWaitTotalMs } from '../actions-timeouts.js'

const WHEN = { kind: 'all', children: [] } as const
const wait = (seconds: number) => ({ kind: 'wait', seconds }) as const

describe('actionWaitTotalMs', () => {
  it('sums sequential waits and counts a wait-until by its timeout', () => {
    const steps: ActionStep[] = [
      wait(10),
      { kind: 'wait-until', when: WHEN, timeoutS: 20, onTimeout: 'continue' },
    ]
    expect(actionWaitTotalMs(steps)).toBe(30_000)
  })

  it('counts a retried probe/http step by its retry window', () => {
    const steps: ActionStep[] = [
      {
        kind: 'http-request',
        url: 'https://x.test',
        method: 'GET',
        timeoutSeconds: 2,
        retryUntilSeconds: 45,
      },
    ]
    expect(actionWaitTotalMs(steps)).toBe(45_000)
  })

  it('counts a parallel by its longest member and a choose by its longest branch or else', () => {
    const steps: ActionStep[] = [
      { kind: 'parallel', steps: [wait(5), wait(30)] },
      {
        kind: 'choose',
        branches: [{ if: WHEN, steps: [wait(7)] }],
        else: [wait(11)],
      },
    ]
    expect(actionWaitTotalMs(steps)).toBe(30_000 + 11_000)
  })

  it('counts a repeat as iterations times its body, and a while by its iteration bound', () => {
    const steps: ActionStep[] = [
      { kind: 'repeat', loop: { by: 'count', count: 3 }, steps: [wait(4)] },
      {
        kind: 'repeat',
        loop: { by: 'while', when: WHEN, maxIterations: 2, waitS: 1 },
        steps: [wait(2)],
      },
    ]
    expect(actionWaitTotalMs(steps)).toBe(12_000 + 2 * 3_000)
  })

  it('counts nothing for a step that only starts something', () => {
    const steps: ActionStep[] = [
      { kind: 'action', actionId: 'internal:x' },
      { kind: 'notify', targetId: 't', body: 'hi' },
    ]
    expect(actionWaitTotalMs(steps)).toBe(0)
  })
})
