import { ACTION_STEP_KINDS } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { ACTION_EDITOR_KINDS } from '../../actions/ActionEditor'
import { offeredStepKinds } from '../ActionList'

describe('the Action editor and the Then editor offer the same step kinds', () => {
  const then = offeredStepKinds(undefined, true)
  const action = offeredStepKinds(ACTION_EDITOR_KINDS, true)

  it('differ only by code, which an Action cannot hold', () => {
    expect([...action].sort()).toEqual(then.filter((kind) => kind !== 'code').sort())
    expect(then).toContain('code')
    expect(action).not.toContain('code')
  })

  it('are the kinds the Action schema accepts', () => {
    expect([...action].sort()).toEqual([...ACTION_STEP_KINDS].sort())
  })

  it('offer the flow steps an Action now takes', () => {
    for (const kind of [
      'http-request',
      'notify',
      'choose',
      'parallel',
      'repeat',
      'wait-until',
      'set',
      'stop',
      'probe',
      'action',
    ] as const) {
      expect(action).toContain(kind)
    }
  })
})
