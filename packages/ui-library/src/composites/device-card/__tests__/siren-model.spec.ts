/**
 * The siren's pure model: what the device declares adjustable (and nothing
 * else), the countdown arithmetic, and a run whose duration is unknown.
 */
import type { SirenOptions } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type SirenRun,
  sirenActivityOf,
  sirenAdjustableOf,
  sirenCountdownOf,
  sirenRunOf,
  sirenTriggerInputOf,
} from '../scenes/siren/model'

const SECONDS_LIST: SirenOptions = {
  allowedSeconds: [10, 30, 60],
  rangeSeconds: null,
  defaultSeconds: 30,
  allowedPlays: null,
  rangePlays: null,
  defaultPlays: null,
  unit: 'seconds',
  secondsPerPlay: null,
  source: 'camera',
  fetchedAt: 1,
}

describe('what the siren declares adjustable', () => {
  it('offers the listed durations and no plays on a seconds siren', () => {
    expect(sirenAdjustableOf(SECONDS_LIST)).toEqual({
      durations: { values: [10, 30, 60] },
      plays: null,
    })
  })

  it('spells a declared range out by its step', () => {
    const options: SirenOptions = {
      ...SECONDS_LIST,
      allowedSeconds: null,
      rangeSeconds: { min: 5, max: 20, step: 5 },
      defaultSeconds: 10,
      unit: 'plays',
      secondsPerPlay: 5,
      rangePlays: { min: 1, max: 3, step: 1 },
      defaultPlays: 2,
    }
    expect(sirenAdjustableOf(options)).toEqual({
      durations: { values: [5, 10, 15, 20] },
      plays: { values: [1, 2, 3] },
    })
  })

  it('draws no chip for a single value: one option is not a choice', () => {
    const options: SirenOptions = {
      ...SECONDS_LIST,
      allowedSeconds: [30],
      allowedPlays: [1],
    }
    expect(sirenAdjustableOf(options)).toEqual({
      durations: null,
      plays: null,
    })
  })

  it('offers nothing while the options have not answered', () => {
    expect(sirenAdjustableOf(undefined)).toEqual({
      durations: null,
      plays: null,
    })
  })
})

function present(run: SirenRun | null): SirenRun {
  if (run === null) throw new Error('expected a run')
  return run
}

describe('the countdown', () => {
  it('reads the reported end and duration', () => {
    const run = sirenRunOf(
      {
        active: true,
        activeUntil: 40_000,
        durationSeconds: 30,
        activeUntilEstimated: false,
        lastTriggeredAt: 10_000,
      },
      true,
    )
    expect(run).toEqual({ endsAt: 40_000, totalMs: 30_000, estimated: false })
    expect(sirenCountdownOf(present(run), 12_400)).toEqual({
      kind: 'timed',
      remainingSeconds: 13,
      fraction: 12_400 / 30_000,
      estimated: false,
    })
  })

  it('takes the span from the trigger to the end when no duration is reported', () => {
    const run = sirenRunOf(
      {
        active: true,
        activeUntil: 25_000,
        durationSeconds: null,
        activeUntilEstimated: true,
        lastTriggeredAt: 5_000,
      },
      true,
    )
    expect(run).toEqual({ endsAt: 25_000, totalMs: 20_000, estimated: true })
    expect(sirenCountdownOf(present(run), 5_000)).toMatchObject({
      fraction: 0.25,
      remainingSeconds: 5,
    })
  })

  it('never fills past the whole ring nor under zero', () => {
    const run = { endsAt: 10_000, totalMs: 5_000, estimated: false }
    expect(sirenCountdownOf(run, 9_000)).toMatchObject({ fraction: 1 })
    expect(sirenCountdownOf(run, 0)).toMatchObject({
      fraction: 0,
      remainingSeconds: 0,
    })
  })

  it('is open — a busy ring with no count — when the end is unknown', () => {
    const run = sirenRunOf(
      {
        active: true,
        activeUntil: null,
        durationSeconds: null,
        activeUntilEstimated: false,
        lastTriggeredAt: 0,
      },
      true,
    )
    expect(run).toEqual({ endsAt: null, totalMs: null, estimated: false })
    expect(sirenCountdownOf(present(run), null)).toEqual({ kind: 'open' })
  })

  it('keeps the count but fills nothing when only the end is known', () => {
    const run = { endsAt: 9_000, totalMs: null, estimated: false }
    expect(sirenCountdownOf(run, 3_000)).toEqual({
      kind: 'timed',
      remainingSeconds: 3,
      fraction: null,
      estimated: false,
    })
  })

  it('has no run while the siren is silent', () => {
    expect(
      sirenRunOf(
        {
          active: false,
          activeUntil: null,
          durationSeconds: 30,
          activeUntilEstimated: false,
          lastTriggeredAt: 1,
        },
        false,
      ),
    ).toBeNull()
  })

  it('runs open on a switch-only siren that sounds', () => {
    expect(sirenRunOf(undefined, true)).toEqual({
      endsAt: null,
      totalMs: null,
      estimated: false,
    })
    expect(sirenRunOf(undefined, false)).toBeNull()
  })
})

describe('the served state and the trigger', () => {
  it('reads sounding from the siren slice, the switch when no siren cap answers', () => {
    expect(sirenActivityOf(true, false)).toBe('sounding')
    expect(sirenActivityOf(false, true)).toBe('silent')
    expect(sirenActivityOf(undefined, true)).toBe('sounding')
    expect(sirenActivityOf(undefined, null)).toBe('unknown')
  })

  it('sends seconds or plays, never both, and nothing for the camera default', () => {
    expect(sirenTriggerInputOf({ unit: 'seconds', value: 30 })).toEqual({
      durationSeconds: 30,
    })
    expect(sirenTriggerInputOf({ unit: 'plays', value: 2 })).toEqual({
      plays: 2,
    })
    expect(sirenTriggerInputOf(null)).toEqual({})
  })
})
