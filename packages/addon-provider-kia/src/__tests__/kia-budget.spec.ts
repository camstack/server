import { describe, expect, it } from 'vitest'
import {
  KIA_CALL_COST,
  KIA_DAILY_CALL_LIMIT,
  KIA_SCHEDULED_RESERVE,
  KiaCallBudget,
} from '../kia-budget.js'

const DAY = 86_400_000
const START = Date.UTC(2026, 10, 22, 8, 0, 0)

function budget(
  clock: { now: number },
  options: { limit?: number; reserve?: number } = {},
): KiaCallBudget {
  return new KiaCallBudget({ now: () => clock.now, ...options })
}

describe('KiaCallBudget', () => {
  it('starts empty and counts what is spent', () => {
    const b = budget({ now: START })
    expect(b.used()).toBe(0)
    b.spend('read')
    b.spend('command')
    expect(b.used()).toBe(KIA_CALL_COST.read + KIA_CALL_COST.command)
  })

  it('refuses a forced refresh or a command once only the scheduled reserve is left', () => {
    const b = budget({ now: START }, { limit: 20, reserve: 5 })
    while (b.check('force').ok) b.spend('force')
    expect(b.used()).toBeLessThanOrEqual(15)
    expect(b.used() + KIA_CALL_COST.force).toBeGreaterThan(15)
    const verdict = b.check('command')
    expect(verdict.ok).toBe(false)
  })

  it('still lets a scheduled read through while the reserve lasts', () => {
    const b = budget({ now: START }, { limit: 20, reserve: 5 })
    while (b.check('force').ok) b.spend('force')
    expect(b.check('read')).toEqual({ ok: true })
  })

  it('refuses even a scheduled read when the whole day is spent', () => {
    const b = budget({ now: START }, { limit: 4, reserve: 1 })
    for (let i = 0; i < 4; i += 1) b.spend('read')
    const verdict = b.check('read')
    expect(verdict.ok).toBe(false)
  })

  it('names the next UTC midnight as the moment a retry may succeed', () => {
    const b = budget({ now: START }, { limit: 1, reserve: 0 })
    b.spend('read')
    const verdict = b.check('command')
    expect(verdict).toEqual({
      ok: false,
      reason: 'budget-exhausted',
      retryAt: Date.UTC(2026, 10, 23),
    })
  })

  it('starts a fresh day at UTC midnight', () => {
    const clock = { now: START }
    const b = budget(clock, { limit: 2, reserve: 0 })
    b.spend('read')
    b.spend('read')
    expect(b.check('read').ok).toBe(false)
    clock.now = START + DAY
    expect(b.used()).toBe(0)
    expect(b.check('read')).toEqual({ ok: true })
  })

  it('can be told the cloud itself refused: nothing more is spent until the next day', () => {
    const clock = { now: START }
    const b = budget(clock)
    b.exhaust()
    expect(b.check('read').ok).toBe(false)
    expect(b.check('command').ok).toBe(false)
    clock.now = START + DAY
    expect(b.check('read')).toEqual({ ok: true })
  })

  it('defaults to about two hundred calls a day with room for the half-hourly reads', () => {
    expect(KIA_DAILY_CALL_LIMIT).toBe(200)
    expect(KIA_SCHEDULED_RESERVE).toBeGreaterThanOrEqual(48)
  })
})
