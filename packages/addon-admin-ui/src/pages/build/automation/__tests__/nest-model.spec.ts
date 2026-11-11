import type { AutomationAction } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { isBranchStep } from '../choose-model'
import { bodyKindsAt, isBodyStep } from '../nest-model'

const WAIT: AutomationAction = { kind: 'wait', seconds: 1 }
const IF = { kind: 'all', children: [] } as const
const repeat = (steps: AutomationAction[]): AutomationAction =>
  ({ kind: 'repeat', loop: { by: 'count', count: 2 }, steps }) as AutomationAction

describe('nest-model (#500)', () => {
  it('a list one level down offers block steps, a list two levels down plain steps only', () => {
    expect(bodyKindsAt(1)).toEqual(
      expect.arrayContaining(['cap', 'wait', 'choose', 'repeat', 'parallel', 'wait-until']),
    )
    expect(bodyKindsAt(1)).not.toContain('code')
    for (const block of ['choose', 'repeat', 'parallel', 'wait-until', 'code']) {
      expect(bodyKindsAt(2)).not.toContain(block)
    }
  })

  it('a plain step is not a block step, and a block step is not a plain one', () => {
    expect(isBranchStep(WAIT)).toBe(true)
    expect(isBranchStep(repeat([WAIT]))).toBe(false)
    expect(isBranchStep({ kind: 'wait-until', when: IF, timeoutS: 5, onTimeout: 'stop' })).toBe(
      false,
    )
  })

  it('a body step is a plain step or a block whose own steps are plain', () => {
    expect(isBodyStep(WAIT)).toBe(true)
    expect(isBodyStep(repeat([WAIT]))).toBe(true)
    expect(isBodyStep({ kind: 'choose', branches: [{ if: IF, steps: [WAIT] }] })).toBe(true)
    expect(isBodyStep(repeat([repeat([WAIT])]))).toBe(false)
    expect(
      isBodyStep({
        kind: 'choose',
        branches: [{ if: IF, steps: [WAIT] }],
        else: [{ kind: 'choose', branches: [{ if: IF, steps: [WAIT] }] }],
      }),
    ).toBe(false)
    expect(isBodyStep({ kind: 'code', code: 'x' })).toBe(false)
  })
})
