import type { AutomationAction, AutomationChooseStep } from '@camstack/types'
import { AutomationChooseStepSchema, CHOOSE_BRANCHES_MAX } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  addBranch,
  canAddBranch,
  isParallelMember,
  isBranchStep,
  newChoose,
  PARALLEL_KINDS,
  removeBranch,
  replaceBranch,
  setElse,
} from '../choose-model'

const WAIT: AutomationAction = { kind: 'wait', seconds: 5 }

function full(): AutomationChooseStep {
  let step = newChoose()
  for (let i = 1; i < CHOOSE_BRANCHES_MAX; i++) step = addBranch(step)
  return step
}

describe('choose-model (#500)', () => {
  it('a new choose has one empty branch and no else', () => {
    expect(newChoose()).toEqual({
      kind: 'choose',
      branches: [{ if: { kind: 'all', children: [] }, steps: [] }],
    })
  })

  it('branches stop at the bound the schema enforces', () => {
    const step = full()
    expect(step.branches).toHaveLength(CHOOSE_BRANCHES_MAX)
    expect(canAddBranch(step)).toBe(false)
    expect(addBranch(step)).toBe(step)
    const over = { ...step, branches: [...step.branches, step.branches[0]] }
    expect(AutomationChooseStepSchema.safeParse(over).success).toBe(false)
  })

  it('the last branch is never removed; another one is, by position', () => {
    const one = newChoose()
    expect(removeBranch(one, 0)).toBe(one)
    const two = replaceBranch(addBranch(one), 1, { if: { kind: 'all', children: [] }, steps: [] })
    const marked = replaceBranch(two, 0, {
      ...two.branches[0]!,
      steps: [{ kind: 'wait', seconds: 5 }],
    })
    expect(removeBranch(marked, 1).branches).toEqual([marked.branches[0]])
    expect(removeBranch(marked, 0).branches).toEqual([marked.branches[1]])
  })

  it('switching the else off removes the key instead of storing an empty list', () => {
    const on = setElse(newChoose(), [])
    expect(on.else).toEqual([])
    expect('else' in setElse(on, undefined)).toBe(false)
  })

  it('a branch holds plain steps: no block, no code, no condition of its own', () => {
    expect(isBranchStep(WAIT)).toBe(true)
    expect(isBranchStep({ kind: 'stop', reason: 'x', outcome: 'ok' })).toBe(true)
    expect(isBranchStep(newChoose())).toBe(false)
    expect(isBranchStep({ kind: 'code', code: 'return' })).toBe(false)
    expect(
      isBranchStep({
        kind: 'stop',
        reason: 'x',
        outcome: 'ok',
        if: { kind: 'all', children: [] },
      }),
    ).toBe(false)
  })
})

describe('parallel members (#500)', () => {
  it('takes a command, an action and a wait, and refuses a set, a stop and a block step', () => {
    expect(isParallelMember({ kind: 'wait', seconds: 5 })).toBe(true)
    expect(isParallelMember({ kind: 'set', vars: {} })).toBe(false)
    expect(isParallelMember({ kind: 'stop', reason: '', outcome: 'ok' })).toBe(false)
    expect(isParallelMember({ kind: 'parallel', steps: [] })).toBe(false)
    expect(PARALLEL_KINDS).toEqual(['command', 'action', 'wait'])
  })
})
