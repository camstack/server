/**
 * `alarm-panel.requiresCode` became `codeRequired` (#459). The cap declares the
 * rename, codegen projects it into the runtime-state policy, and the boot seed
 * (`restoredPart`, packages/system) reads a pre-rename row into the new name.
 */
import { describe, expect, it } from 'vitest'
import { runtimeStatePolicyFor } from '../generated/runtime-state-durability.js'
import { AlarmPanelStatusSchema } from '../capabilities/alarm-panel.cap.js'

describe('restoredFieldRenames — alarm-panel', () => {
  it('the generated policy carries the rename', () => {
    expect(runtimeStatePolicyFor('alarm-panel').renamedFields).toEqual({
      requiresCode: 'codeRequired',
    })
  })

  it('a pre-rename slice upgraded by the seed parses with its value', () => {
    const upgraded = {
      state: 'armed_away',
      availableModes: ['away'],
      codeRequired: true,
      lastChangedAt: 5,
    }
    expect(AlarmPanelStatusSchema.parse(upgraded).codeRequired).toBe(true)
  })

  it('caps without a rename declare none', () => {
    expect(runtimeStatePolicyFor('lock-control').renamedFields).toBeUndefined()
  })
})
