import { describe, expect, it } from 'vitest'
import { planBoot } from '../boot-plan.js'

describe('planBoot (single-copy model)', () => {
  it('boots the current closure when it validated', () => {
    const plan = planBoot(true)
    expect(plan.kind).toBe('current')
  })

  it('falls back to the baked seed when the current closure is invalid/absent', () => {
    const plan = planBoot(false)
    expect(plan.kind).toBe('baked')
    expect(plan.reason).toMatch(/baked seed/)
  })
})
