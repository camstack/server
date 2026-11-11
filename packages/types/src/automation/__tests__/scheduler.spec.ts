import { describe, expect, it } from 'vitest'
import {
  type SchedulerInput,
  SchedulerInputSchema,
  SchedulerStateTreeSchema,
  validateSchedulerInput,
} from '../scheduler.js'

const WITH_LOCATION = {
  location: { latitude: 41.9, longitude: 12.5 },
  timeZone: 'Europe/Rome',
}
const NO_LOCATION = { location: null, timeZone: 'Europe/Rome' }

function input(
  mode: 'edge' | 'hold',
  step: object,
  at: object = { kind: 'clock', hh: 8, mm: 0 },
): SchedulerInput {
  return SchedulerInputSchema.parse({
    name: 'S',
    profiles: [
      {
        id: 'p',
        name: 'P',
        days: ['mon'],
        points: [{ id: 'a', at, mode, steps: [step] }],
      },
    ],
  })
}

const SWITCH_ON = {
  kind: 'cap',
  actionId: 'switch.on',
  target: { kind: 'devices', ids: [1] },
  cap: 'switch',
  method: 'setState',
  args: { on: true },
}
const TOGGLE = {
  kind: 'cap',
  target: { kind: 'devices', ids: [1] },
  cap: 'switch',
  method: 'toggle',
  args: {},
}

describe('validateSchedulerInput', () => {
  it('accepts a hold whose action leads to a state', () => {
    expect(validateSchedulerInput(input('hold', SWITCH_ON), WITH_LOCATION)).toEqual({ ok: true })
  })

  it('refuses a hold whose step has no effect, with a reason', () => {
    const result = validateSchedulerInput(input('hold', TOGGLE), WITH_LOCATION)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.message).toMatch(/raw call|does not lead to a state/)
  })

  it('allows the same step as an edge', () => {
    expect(validateSchedulerInput(input('edge', TOGGLE), WITH_LOCATION)).toEqual({ ok: true })
  })

  it('refuses a sun point when the site has no location', () => {
    const sun = { kind: 'sun', event: 'sunset', offsetMin: 0 }
    const result = validateSchedulerInput(input('edge', SWITCH_ON, sun), NO_LOCATION)
    expect(result.ok).toBe(false)
    expect(validateSchedulerInput(input('edge', SWITCH_ON, sun), WITH_LOCATION)).toEqual({
      ok: true,
    })
  })

  it('refuses a sun-bounded time-is window when the site has no location, wherever the tree sits', () => {
    const afterSunset = {
      kind: 'time-is',
      between: {
        from: { kind: 'sun', event: 'sunset', offsetMin: 0 },
        to: { kind: 'clock', hh: 23, mm: 0 },
      },
    }
    const guarded = { ...SWITCH_ON, if: afterSunset }
    const base = input('edge', guarded)
    const whole = SchedulerInputSchema.parse({
      ...base,
      activeWhen: afterSunset,
      profiles: base.profiles.map((p) => ({
        ...p,
        activeWhen: afterSunset,
        points: p.points.map((pt) => ({ ...pt, conditions: afterSunset })),
      })),
    })
    const result = validateSchedulerInput(whole, NO_LOCATION)
    expect(result.ok ? [] : result.issues.map((i) => i.path)).toEqual([
      'activeWhen.between.from',
      'profiles.0.activeWhen.between.from',
      'profiles.0.points.0.conditions.between.from',
      'profiles.0.points.0.steps.0.if.between.from',
    ])
    expect(result.ok ? '' : result.issues[0]?.message).toContain('needs the site location')
    expect(validateSchedulerInput(whole, WITH_LOCATION)).toEqual({ ok: true })
  })

  it('refuses an event leaf in a state tree', () => {
    const event = {
      kind: 'device-event',
      deviceId: 1,
      cap: 'switch',
      event: 'x',
    }
    expect(SchedulerStateTreeSchema.safeParse(event).success).toBe(false)
  })

  it('refuses a one-shot date as a point time', () => {
    const date = { kind: 'date', local: '2026-03-10T08:00' }
    expect(() => input('edge', SWITCH_ON, date)).toThrow()
  })
})
