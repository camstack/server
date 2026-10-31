import { type ActionStep, type SchedulerInput, schedulersCapability } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  checkSchedulerDraft,
  emptySchedulerDraft,
  holdBands,
  newPoint,
  parseClockText,
  pointMinute,
  timeSpecAfterDrag,
  type SiteView,
} from '../scheduler-model'

const ROME: SiteView = {
  timeZone: 'Europe/Rome',
  location: { latitude: 41.9, longitude: 12.5 },
}
const NO_LOCATION: SiteView = { timeZone: 'Europe/Rome', location: null }

describe('timeline drag → time', () => {
  it('a clock point takes the dragged minute as hh:mm', () => {
    expect(timeSpecAfterDrag({ kind: 'clock', hh: 7, mm: 0 }, 19 * 60 + 35, null)).toEqual({
      kind: 'clock',
      hh: 19,
      mm: 35,
    })
  })
  it('a sun point keeps its event and moves its offset from the sun time', () => {
    const spec = { kind: 'sun', event: 'sunset', offsetMin: 0 } as const
    expect(timeSpecAfterDrag(spec, 17 * 60 + 40, 17 * 60)).toEqual({
      kind: 'sun',
      event: 'sunset',
      offsetMin: 40,
    })
    expect(timeSpecAfterDrag(spec, 16 * 60, 17 * 60)).toEqual({
      kind: 'sun',
      event: 'sunset',
      offsetMin: -60,
    })
  })
  it('a sun point without a known sun time is not moved', () => {
    const spec = { kind: 'sun', event: 'dawn', offsetMin: 10 } as const
    expect(timeSpecAfterDrag(spec, 400, null)).toEqual(spec)
  })
  it('a sun offset stays inside the 12 hour limit the schema allows', () => {
    const spec = { kind: 'sun', event: 'sunrise', offsetMin: 0 } as const
    expect(timeSpecAfterDrag(spec, 1439, 0)).toEqual({
      ...spec,
      offsetMin: 720,
    })
  })
})

describe('where a point sits on the day', () => {
  it('a clock point is its own minute', () => {
    expect(pointMinute({ kind: 'clock', hh: 6, mm: 30 }, ROME, '2026-06-21')).toBe(390)
  })
  it('a sun point is read from the site, in the site zone', () => {
    const minute = pointMinute({ kind: 'sun', event: 'sunrise', offsetMin: 0 }, ROME, '2026-06-21')
    expect(minute).not.toBeNull()
    // Rome sunrise at the June solstice is about 05:35 local (CEST).
    expect(minute).toBeGreaterThan(5 * 60)
    expect(minute).toBeLessThan(6 * 60)
  })
  it('a sun point with no site location has no place', () => {
    expect(
      pointMinute({ kind: 'sun', event: 'sunset', offsetMin: 0 }, NO_LOCATION, '2026-06-21'),
    ).toBeNull()
  })
})

describe('hold windows', () => {
  it('a hold lasts until the next point, the last one until midnight', () => {
    const points = [
      { ...newPoint('hold', 'a', 8 * 60) },
      { ...newPoint('release', 'b', 12 * 60) },
      { ...newPoint('hold', 'c', 20 * 60) },
    ]
    expect(holdBands(points, ROME, '2026-06-21')).toEqual([
      { id: 'a', fromMinute: 480, toMinute: 720 },
      { id: 'c', fromMinute: 1200, toMinute: 1440 },
    ])
  })
})

describe('point editor input', () => {
  it('parses HH:MM and refuses anything else', () => {
    expect(parseClockText('07:05')).toEqual({ kind: 'clock', hh: 7, mm: 5 })
    expect(parseClockText('7:5')).toBeNull()
    expect(parseClockText('24:00')).toBeNull()
    expect(parseClockText('12:60')).toBeNull()
  })
})

describe('save payload', () => {
  const holdStep: ActionStep = {
    kind: 'cap',
    actionId: 'switch.on',
    cap: 'switch',
    method: 'setState',
    args: { on: true },
    target: { kind: 'devices', ids: [3] },
  }

  function draftWith(mode: 'edge' | 'hold'): SchedulerInput {
    const base = emptySchedulerDraft()
    const point = { ...newPoint(mode, 'p1', 8 * 60), steps: [holdStep] }
    return {
      ...base,
      name: 'Garden lights',
      profiles: [{ ...base.profiles[0]!, points: [point] }],
    }
  }

  it('an empty name is refused with its reason', () => {
    const check = checkSchedulerDraft(emptySchedulerDraft(), ROME)
    expect(check.ok).toBe(false)
  })

  it('a valid draft produces exactly what schedulers.create accepts', () => {
    const check = checkSchedulerDraft(draftWith('edge'), ROME)
    expect(check.ok).toBe(true)
    if (!check.ok) return
    const parsed = schedulersCapability.methods.create.input.safeParse({
      scheduler: check.input,
    })
    expect(parsed.success).toBe(true)
  })

  it('a hold with a step that leads to no state is refused with the path', () => {
    const draft = draftWith('hold')
    const point = draft.profiles[0]!.points[0]!
    const bad: SchedulerInput = {
      ...draft,
      profiles: [
        {
          ...draft.profiles[0]!,
          points: [{ ...point, steps: [{ kind: 'wait', seconds: 1 }] }],
        },
      ],
    }
    const check = checkSchedulerDraft(bad, ROME)
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.issues[0]?.path).toBe('profiles.0.points.0.steps.0')
  })

  it('a sun point on a site without a location is refused', () => {
    const draft = draftWith('edge')
    const point = draft.profiles[0]!.points[0]!
    const sun: SchedulerInput = {
      ...draft,
      profiles: [
        {
          ...draft.profiles[0]!,
          points: [{ ...point, at: { kind: 'sun', event: 'sunset', offsetMin: 0 } }],
        },
      ],
    }
    const check = checkSchedulerDraft(sun, NO_LOCATION)
    expect(check.ok).toBe(false)
  })
})
