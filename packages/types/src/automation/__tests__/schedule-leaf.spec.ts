import { describe, expect, it } from 'vitest'
import { AutomationWhenSchema } from '../when.js'

describe('the schedule leaf (D983)', () => {
  it('keeps the legacy cron form parseable', () => {
    expect(AutomationWhenSchema.safeParse({ kind: 'schedule', cron: '30 23 * * *' }).success).toBe(
      true,
    )
  })

  it('takes a time spec, with weekdays', () => {
    const parsed = AutomationWhenSchema.safeParse({
      kind: 'schedule',
      at: { kind: 'sun', event: 'sunset', offsetMin: -15 },
      days: ['mon', 'fri'],
    })
    expect(parsed.success).toBe(true)
  })

  it('names exactly one of at and cron', () => {
    expect(AutomationWhenSchema.safeParse({ kind: 'schedule' }).success).toBe(false)
    expect(
      AutomationWhenSchema.safeParse({
        kind: 'schedule',
        cron: '* * * * *',
        at: { kind: 'clock', hh: 1, mm: 0 },
      }).success,
    ).toBe(false)
  })

  it('refuses weekdays on a cron schedule, which carries its own', () => {
    expect(
      AutomationWhenSchema.safeParse({ kind: 'schedule', cron: '0 7 * * *', days: ['mon'] })
        .success,
    ).toBe(false)
  })
})
