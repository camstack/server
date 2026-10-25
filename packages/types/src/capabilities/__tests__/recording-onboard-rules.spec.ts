/**
 * `recording-onboard` rules — the shared refusal vocabulary and the two
 * schedule coordinate systems.
 *
 * The mask and `TimeOfDay` cases below are the bytes the fleet actually
 * produced on 2026-09-22, not hand-invented ones: the 168-char tables
 * are copied from `getRecordSchedule` on 592 and 618, and the `00:00:00`
 * / `24:00` pair is copied from 1436's `record/tracks`. That pair is the
 * whole reason `timeOfDayToMinutes` exists — the firmware spells the
 * start and the end of the same block two different ways, and a parser
 * written against the specification handles only one of them.
 */
import { describe, expect, it } from 'vitest'
import type { RecordWindow, RecordingOnboardOptions } from '../recording-onboard.cap.js'
import {
  describeOnboardClamp,
  WEEKLY_MASK_LENGTH,
  dayOfWeekToIndex,
  describeOnboardRefusal,
  minutesToTimeOfDay,
  timeOfDayToMinutes,
  weeklyMaskIsUniform,
  weeklyMaskToWindows,
  windowsToWeeklyMask,
} from '../recording-onboard-rules.js'

/** Verbatim from `getRecordSchedule` on 592 and 618, type `MD`. */
const MASK_ALL_ON =
  '111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111'
/** Verbatim from the same reads, type `Normal`. */
const MASK_ALL_OFF =
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'

function maskWith(set: ReadonlyArray<readonly [number, number]>): string {
  const slots = new Array<string>(WEEKLY_MASK_LENGTH).fill('0')
  for (const [day, hour] of set) slots[day * 24 + hour] = '1'
  return slots.join('')
}

/** A permissive camera: everything readable and writable, minute-resolution. */
function options(overrides: Partial<RecordingOnboardOptions> = {}): RecordingOnboardOptions {
  const yes = { readable: true, writable: true }
  return {
    enabled: yes,
    overwriteWhenFull: yes,
    preRecordSec: yes,
    preRecordSecRange: { min: 0, max: 30, step: 1 },
    postRecordSec: yes,
    postRecordSecRange: { min: 0, max: 60, step: 1 },
    segmentMinutes: yes,
    segmentMinutesRange: { min: 1, max: 60, step: 1 },
    schedule: {
      support: yes,
      granularityMinutes: 1,
      triggers: ['continuous', 'motion'],
      supportsOverlappingTriggers: true,
    },
    ...overrides,
  }
}

describe('the live masks the fleet produced', () => {
  it('both are exactly 168 characters — 7 days of 24 hours', () => {
    expect(MASK_ALL_ON).toHaveLength(WEEKLY_MASK_LENGTH)
    expect(MASK_ALL_OFF).toHaveLength(WEEKLY_MASK_LENGTH)
  })

  it('are uniform, which is why the day-major layout cannot be wrong for them', () => {
    expect(weeklyMaskIsUniform(MASK_ALL_ON)).toBe(true)
    expect(weeklyMaskIsUniform(MASK_ALL_OFF)).toBe(true)
    expect(weeklyMaskIsUniform(maskWith([[0, 3]]))).toBe(false)
  })

  it('an all-on mask is seven whole-day windows, not one hundred and sixty-eight', () => {
    const windows = weeklyMaskToWindows(MASK_ALL_ON, 'motion')
    expect(windows).toHaveLength(7)
    expect(windows[0]).toEqual({ trigger: 'motion', day: 0, startMinute: 0, endMinute: 1440 })
    expect(windows[6]).toEqual({ trigger: 'motion', day: 6, startMinute: 0, endMinute: 1440 })
  })

  it('an all-off mask is no windows at all', () => {
    expect(weeklyMaskToWindows(MASK_ALL_OFF, 'continuous')).toEqual([])
  })

  it('merges only ADJACENT hours, and splits a gap into two windows', () => {
    const mask = maskWith([
      [2, 6],
      [2, 7],
      [2, 9],
    ])
    expect(weeklyMaskToWindows(mask, 'motion')).toEqual([
      { trigger: 'motion', day: 2, startMinute: 360, endMinute: 480 },
      { trigger: 'motion', day: 2, startMinute: 540, endMinute: 600 },
    ])
  })

  it('refuses to read a table of the wrong length rather than inventing fewer days', () => {
    expect(weeklyMaskToWindows(MASK_ALL_ON.slice(0, 100), 'motion')).toEqual([])
  })
})

describe('windowsToWeeklyMask', () => {
  it('round-trips the all-on mask', () => {
    expect(windowsToWeeklyMask(weeklyMaskToWindows(MASK_ALL_ON, 'motion'), 'motion')).toBe(
      MASK_ALL_ON,
    )
  })

  it('ignores windows belonging to another trigger — the mask is per trigger', () => {
    const windows: RecordWindow[] = [
      { trigger: 'motion', day: 0, startMinute: 0, endMinute: 60 },
      { trigger: 'continuous', day: 1, startMinute: 0, endMinute: 60 },
    ]
    expect(windowsToWeeklyMask(windows, 'motion')).toBe(maskWith([[0, 0]]))
  })

  it('never drops coverage: a part-hour window sets the whole hour', () => {
    const windows: RecordWindow[] = [{ trigger: 'motion', day: 0, startMinute: 30, endMinute: 45 }]
    expect(windowsToWeeklyMask(windows, 'motion')).toBe(maskWith([[0, 0]]))
  })
})

describe("Hikvision's two spellings of the same clock", () => {
  it('reads the start and end of 1436 track 101 — different formats, one block', () => {
    expect(timeOfDayToMinutes('00:00:00')).toBe(0)
    expect(timeOfDayToMinutes('24:00')).toBe(1440)
  })

  it('reads 1436 track 103, which is not hour-aligned', () => {
    expect(timeOfDayToMinutes('00:05:00')).toBe(5)
    expect(timeOfDayToMinutes('23:57:00')).toBe(1437)
  })

  it('never folds end-of-day into midnight', () => {
    expect(timeOfDayToMinutes('24:00')).not.toBe(0)
  })

  it('answers null rather than midnight for something it did not understand', () => {
    expect(timeOfDayToMinutes('')).toBeNull()
    expect(timeOfDayToMinutes('nothing')).toBeNull()
    expect(timeOfDayToMinutes('12:99')).toBeNull()
    expect(timeOfDayToMinutes('25:00')).toBeNull()
  })

  it('writes back the spelling the camera itself uses', () => {
    expect(minutesToTimeOfDay(0)).toBe('00:00:00')
    expect(minutesToTimeOfDay(1440)).toBe('24:00')
    expect(minutesToTimeOfDay(1437)).toBe('23:57:00')
  })

  it('maps the weekday names the camera emits', () => {
    expect(dayOfWeekToIndex('Monday')).toBe(0)
    expect(dayOfWeekToIndex('sunday')).toBe(6)
    expect(dayOfWeekToIndex('Caturday')).toBeNull()
  })
})

describe('describeOnboardRefusal — a write a camera cannot honour is refused BY NAME', () => {
  it('accepts a patch every field of which the camera can take', () => {
    expect(describeOnboardRefusal(options(), { preRecordSec: 10, enabled: true })).toBeNull()
  })

  it('names the field AND the camera-supplied reason when it is not writable', () => {
    const refusal = describeOnboardRefusal(
      options({
        preRecordSec: {
          readable: true,
          writable: false,
          reason: 'no verified setter on this firmware',
        },
      }),
      { preRecordSec: 10 },
    )
    expect(refusal).toContain('pre-record seconds')
    expect(refusal).toContain('no verified setter on this firmware')
  })

  it('refuses a value outside the range the camera advertised, quoting both', () => {
    const refusal = describeOnboardRefusal(options(), { preRecordSec: 900 })
    expect(refusal).toContain('900')
    expect(refusal).toContain('30')
  })

  it('refuses a trigger the camera cannot record on, and says what it CAN do', () => {
    const refusal = describeOnboardRefusal(options(), {
      windows: [{ trigger: 'animal', day: 0, startMinute: 0, endMinute: 60 }],
    })
    expect(refusal).toContain('animal')
    expect(refusal).toContain('continuous, motion')
  })

  it('refuses a window Reolink cannot express, rather than rounding it to the hour', () => {
    const reolinkish = options({
      schedule: {
        support: { readable: true, writable: true },
        granularityMinutes: 60,
        triggers: ['motion'],
        supportsOverlappingTriggers: true,
      },
    })
    const refusal = describeOnboardRefusal(reolinkish, {
      windows: [{ trigger: 'motion', day: 1, startMinute: 390, endMinute: 1440 }],
    })
    expect(refusal).toContain('60-minute steps')
    expect(refusal).toContain('06:30')
  })

  it('accepts the same window when it IS hour-aligned', () => {
    const reolinkish = options({
      schedule: {
        support: { readable: true, writable: true },
        granularityMinutes: 60,
        triggers: ['motion'],
        supportsOverlappingTriggers: true,
      },
    })
    expect(
      describeOnboardRefusal(reolinkish, {
        windows: [{ trigger: 'motion', day: 1, startMinute: 360, endMinute: 1440 }],
      }),
    ).toBeNull()
  })

  it('refuses two triggers over one range where the camera stores only one', () => {
    const hikvisionish = options({
      schedule: {
        support: { readable: true, writable: true },
        granularityMinutes: 1,
        triggers: ['continuous', 'motion'],
        supportsOverlappingTriggers: false,
      },
    })
    const refusal = describeOnboardRefusal(hikvisionish, {
      windows: [
        { trigger: 'motion', day: 3, startMinute: 0, endMinute: 720 },
        { trigger: 'continuous', day: 3, startMinute: 600, endMinute: 1440 },
      ],
    })
    expect(refusal).toContain('one trigger per time range')
    expect(refusal).toContain('10:00')
  })

  it('allows the same two windows on DIFFERENT days', () => {
    const hikvisionish = options({
      schedule: {
        support: { readable: true, writable: true },
        granularityMinutes: 1,
        triggers: ['continuous', 'motion'],
        supportsOverlappingTriggers: false,
      },
    })
    expect(
      describeOnboardRefusal(hikvisionish, {
        windows: [
          { trigger: 'motion', day: 3, startMinute: 0, endMinute: 720 },
          { trigger: 'continuous', day: 4, startMinute: 600, endMinute: 1440 },
        ],
      }),
    ).toBeNull()
  })

  it('refuses a window that ends before it starts', () => {
    const refusal = describeOnboardRefusal(options(), {
      windows: [{ trigger: 'motion', day: 0, startMinute: 600, endMinute: 60 }],
    })
    expect(refusal).toContain('Monday')
  })

  it('says nothing about a field the patch does not mention', () => {
    const noWrites = options({
      enabled: { readable: true, writable: false, reason: 'read-only here' },
    })
    expect(describeOnboardRefusal(noWrites, { preRecordSec: 5 })).toBeNull()
  })
})

describe('describeOnboardClamp — what the camera stored instead', () => {
  it('names a field the camera took a DIFFERENT value for', () => {
    // Measured on 1436: asked 8, answered 200/OK, stored 5. Re-reading makes
    // that visible; only this makes it explained.
    expect(describeOnboardClamp({ preRecordSec: 8 }, { preRecordSec: 5 })).toEqual([
      { field: 'preRecordSec', asked: 8, stored: 5 },
    ])
  })

  it('is SILENT when the camera took the value verbatim', () => {
    expect(describeOnboardClamp({ preRecordSec: 10 }, { preRecordSec: 10 })).toEqual([])
  })

  it('compares only the fields the patch NAMED', () => {
    // A field nobody asked about cannot have been clamped. Comparing the whole
    // status would report every unrelated difference as a substitution.
    expect(
      describeOnboardClamp({ preRecordSec: 10 }, { preRecordSec: 10, postRecordSec: 15 }),
    ).toEqual([])
  })

  it('a read-back that could not answer is `null`, never a claim', () => {
    // D393: absent is not zero and not false. The operator is told the camera
    // did not say, rather than that it stored nothing.
    expect(describeOnboardClamp({ preRecordSec: 8 }, null)).toEqual([
      { field: 'preRecordSec', asked: 8, stored: null },
    ])
    expect(describeOnboardClamp({ preRecordSec: 8 }, {})).toEqual([
      { field: 'preRecordSec', asked: 8, stored: null },
    ])
  })

  it('handles the booleans and strings a patch can carry', () => {
    expect(
      describeOnboardClamp(
        { enabled: true, overwriteWhenFull: false },
        { enabled: false, overwriteWhenFull: false },
      ),
    ).toEqual([{ field: 'enabled', asked: true, stored: false }])
  })
})

describe('a declared SET beats a span — the two firmwares have no expressible range', () => {
  const opts = {
    enabled: { readable: true, writable: true },
    overwriteWhenFull: { readable: true, writable: true },
    preRecordSec: { readable: true, writable: true },
    preRecordSecAllowed: {
      values: [0, 5, 10, 15, 20, 25, 30, 2147483647],
      sentinel: { value: 2147483647, meaning: 'no-limit' as const },
    },
    postRecordSec: { readable: true, writable: true },
    postRecordSecAllowed: { values: [5, 10, 30, 60, 120, 300, 600] },
    segmentMinutes: { readable: false, writable: false, reason: 'not on this firmware' },
    schedule: {
      support: { readable: true, writable: true },
      granularityMinutes: 1,
      triggers: ['continuous', 'motion'] as const,
      supportsOverlappingTriggers: false,
    },
  }

  it('takes a member of the set', () => {
    expect(describeOnboardRefusal(opts as never, { preRecordSec: 25 })).toBeNull()
    expect(describeOnboardRefusal(opts as never, { postRecordSec: 600 })).toBeNull()
  })

  it('refuses a value the camera would silently replace', () => {
    // 8 is the one measured on the operator's camera: 200/OK, stored 5.
    const r = describeOnboardRefusal(opts as never, { preRecordSec: 8 })
    expect(r).toContain('only as')
    expect(r).toContain('8 is not one of them')
  })

  it('names the sentinel as "no limit", never as two billion seconds', () => {
    expect(describeOnboardRefusal(opts as never, { preRecordSec: 2147483647 })).toBeNull()
    const r = describeOnboardRefusal(opts as never, { preRecordSec: 7 })
    expect(r).toContain('no limit')
    expect(r).not.toContain('2147483647')
  })

  it('accepts the post-record values ABOVE the old range, and refuses one below', () => {
    // The pair that proves a span was wrong in both directions at once.
    expect(describeOnboardRefusal(opts as never, { postRecordSec: 300 })).toBeNull()
    expect(describeOnboardRefusal(opts as never, { postRecordSec: 3 })).toContain('not one of them')
  })
})
