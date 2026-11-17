/**
 * Siren plays mode (planning#589): a trigger asks EITHER seconds OR plays, the
 * camera declares the plays it supports, and the status reports the activation
 * in the unit that was asked — with the countdown marked as an estimate when
 * the seconds-per-play factor was not read from the camera.
 */
import { describe, expect, it } from 'vitest'
import {
  planSirenTrigger,
  resolveSirenPlays,
  sirenIdleStatus,
  sirenPlayChoices,
  sirenTriggeredStatus,
} from '../siren-duration.js'
import {
  SirenOptionsSchema,
  SirenStatusSchema,
  sirenCapability,
  type SirenOptions,
} from '../siren.cap.js'

const secondsCamera: SirenOptions = {
  allowedSeconds: null,
  rangeSeconds: { min: 1, max: 600, step: 1 },
  defaultSeconds: 10,
  allowedPlays: null,
  rangePlays: null,
  defaultPlays: null,
  unit: 'seconds',
  secondsPerPlay: null,
  source: 'camera',
  fetchedAt: 1,
}

const playsCamera: SirenOptions = {
  allowedSeconds: null,
  rangeSeconds: { min: 2, max: 120, step: 2 },
  defaultSeconds: 10,
  allowedPlays: null,
  rangePlays: { min: 1, max: 60, step: 1 },
  defaultPlays: 5,
  unit: 'plays',
  secondsPerPlay: 2,
  source: 'fallback',
  fetchedAt: 1,
}

describe('trigger input — seconds or plays, never both', () => {
  const input = sirenCapability.methods.trigger.input

  it('accepts either unit alone, or neither (the camera default)', () => {
    expect(input.safeParse({ deviceId: 1, durationSeconds: 5 }).success).toBe(true)
    expect(input.safeParse({ deviceId: 1, plays: 3 }).success).toBe(true)
    expect(input.safeParse({ deviceId: 1 }).success).toBe(true)
  })

  it('refuses both at once, and a fractional or zero play count', () => {
    expect(input.safeParse({ deviceId: 1, durationSeconds: 5, plays: 3 }).success).toBe(false)
    expect(input.safeParse({ deviceId: 1, plays: 1.5 }).success).toBe(false)
    expect(input.safeParse({ deviceId: 1, plays: 0 }).success).toBe(false)
  })
})

describe('options and status from a provider that predates plays', () => {
  it('reads as declaring no plays, and an activation without a plays count', () => {
    const options = SirenOptionsSchema.parse({
      allowedSeconds: [5, 10],
      rangeSeconds: null,
      defaultSeconds: 5,
      unit: 'seconds',
      secondsPerPlay: null,
      source: 'camera',
      fetchedAt: 1,
    })
    expect(options).toMatchObject({ allowedPlays: null, rangePlays: null, defaultPlays: null })
    const status = SirenStatusSchema.parse({
      active: true,
      activeUntil: 10,
      durationSeconds: 5,
      lastTriggeredAt: 5,
    })
    expect(status).toMatchObject({ plays: null, activeUntilEstimated: false })
  })
})

describe('resolveSirenPlays', () => {
  it('is null when the camera declares no plays', () => {
    expect(resolveSirenPlays(secondsCamera, 3)).toBeNull()
  })

  it('clamps into the range, and uses the default when nothing is asked', () => {
    expect(resolveSirenPlays(playsCamera, 99)).toBe(60)
    expect(resolveSirenPlays(playsCamera, 0)).toBe(1)
    expect(resolveSirenPlays(playsCamera, undefined)).toBe(5)
  })

  it('snaps to the nearest listed count', () => {
    expect(resolveSirenPlays({ ...playsCamera, allowedPlays: [1, 3, 10] }, 6)).toBe(3)
  })
})

describe('sirenPlayChoices — what the rule picker offers', () => {
  it('lists the counts a plays camera accepts, and nothing for a seconds camera', () => {
    expect(sirenPlayChoices({ ...playsCamera, rangePlays: { min: 1, max: 4, step: 1 } })).toEqual([
      1, 2, 3, 4,
    ])
    expect(sirenPlayChoices({ ...playsCamera, allowedPlays: [2, 5] })).toEqual([2, 5])
    expect(sirenPlayChoices(secondsCamera)).toEqual([])
  })
})

describe('planSirenTrigger', () => {
  it('refuses plays on a camera that counts seconds, naming why', () => {
    const plan = planSirenTrigger(secondsCamera, { plays: 3 })
    expect(plan.asked).toBe('refused')
  })

  it('plays on a plays camera: the count, its estimated seconds', () => {
    expect(planSirenTrigger(playsCamera, { plays: 4 })).toEqual({
      asked: 'plays',
      plays: 4,
      seconds: 8,
      estimated: true,
    })
    expect(planSirenTrigger({ ...playsCamera, source: 'camera' }, { plays: 4 })).toMatchObject({
      estimated: false,
    })
  })

  it('seconds keep the old snapping; the end is an estimate only through a plays factor', () => {
    expect(planSirenTrigger(secondsCamera, { durationSeconds: 12 })).toEqual({
      asked: 'seconds',
      seconds: 12,
      estimated: false,
    })
    expect(planSirenTrigger(playsCamera, { durationSeconds: 11 })).toMatchObject({
      asked: 'seconds',
      estimated: true,
    })
  })
})

describe('the status in the unit that was asked', () => {
  it('a plays activation reports its count and marks the countdown as estimated', () => {
    expect(sirenTriggeredStatus(1_000, 8, { plays: 4, estimated: true })).toEqual({
      active: true,
      activeUntil: 9_000,
      durationSeconds: 8,
      plays: 4,
      activeUntilEstimated: true,
      lastTriggeredAt: 1_000,
    })
  })

  it('a seconds activation has no count; idle keeps the last count', () => {
    expect(sirenTriggeredStatus(1_000, 5)).toMatchObject({
      plays: null,
      activeUntilEstimated: false,
    })
    const idle = sirenIdleStatus(sirenTriggeredStatus(1_000, 8, { plays: 4, estimated: true }))
    expect(idle).toMatchObject({ active: false, plays: 4, activeUntilEstimated: false })
  })
})

describe('the rule action', () => {
  it('offers a plays picker read from the device', () => {
    const actions = sirenCapability.methods.trigger.actions ?? []
    const byPlays = actions.find((a) => a.id === 'siren.triggerPlays')
    expect(byPlays?.openArgs?.[0]).toMatchObject({
      key: 'plays',
      offer: { kind: 'dynamic', from: 'method', method: 'getPlayChoices', valueKind: 'number' },
    })
    expect(byPlays?.phrase.en).toContain('{plays}')
    expect(byPlays?.phrase.it).toContain('{plays}')
  })
})
