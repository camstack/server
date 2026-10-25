/**
 * The Timelapse tab's pure half.
 *
 * The fixtures are the TWO RULES THAT ARE LIVE ON THE HUB, fetched verbatim
 * from `nc.listTimelapseRules` on 2026-08-13 (`Timelapse front door` 80b14eac,
 * `Timelapse retro` 16fa78ac). They are the reason this suite exists in this
 * shape: the first thing this editor will ever do is open one of them, and an
 * open-and-save that changed a single field the operator did not touch would
 * retune a producer that runs unattended at 07:00.
 *
 * Both live rules carry NO `denseCadenceSec`, NO `minDwellSec`, NO `template`,
 * NO `previewText` and NO `reportClasses`. The absence of `denseCadenceSec` in
 * particular is LOAD-BEARING: absent means "derive it from the base cadence"
 * (`max(1s, cadenceSec/30)`), so a form that displayed the derived number and
 * saved it back would pin today's derivation into the rule and silently freeze
 * it the next time the base cadence changed.
 */
import { describe, expect, it } from 'vitest'

import {
  buildTimelapseCreateInput,
  buildTimelapsePatch,
  DEFAULT_TIMELAPSE_TAB,
  denseRangeOutputSeconds,
  derivedDenseCadenceSec,
  emptyTimelapseForm,
  isTimelapseFormValid,
  NC_TIMELAPSE_TABS,
  parseTimelapseRules,
  parseTimelapseTab,
  parseTimelapseTestOutcome,
  type TimelapseFormState,
  timelapseFormProblems,
  timelapseFormWarnings,
  timelapseLastGeneratedLabel,
  timelapseRuleToForm,
  timelapseScheduleLabel,
} from '../notification-timelapse.helpers'

/** `Timelapse front door`, exactly as the hub answers it. */
const LIVE_FRONT_DOOR = {
  name: 'Timelapse front door',
  enabled: true,
  deviceIds: [101],
  schedule: {
    windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1260, endMinute: 420 }],
    timezone: 'Europe/Rome',
  },
  cadenceSec: 30,
  framerate: 12,
  targets: [{ targetId: 'zentik-1784924941052' }],
  previewMode: 'image',
  priority: 2,
  id: '80b14eac-be1b-4a8f-bccb-1aa04acc4c14',
  lastGeneratedAt: 1786598346092,
  generatedByDevice: { '101': 1786598346092 },
  createdBy: '1476a68a-9864-4aa7-bfb5-a779f9d24ff3',
  createdAt: 1786530558379,
  updatedAt: 1786530558379,
  readOnly: false,
}

/** `Timelapse retro`. Same shape, second camera. */
const LIVE_RETRO = {
  ...LIVE_FRONT_DOOR,
  name: 'Timelapse retro',
  deviceIds: [1441],
  id: '16fa78ac-9601-4af4-92dd-6ce9783863b3',
  lastGeneratedAt: 1786599255014,
  generatedByDevice: { '1441': 1786599255014 },
}

function form(patch: Partial<TimelapseFormState> = {}): TimelapseFormState {
  return {
    ...emptyTimelapseForm(),
    name: 'Nightly',
    deviceIds: [101],
    schedule: {
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1260, endMinute: 420 }],
    },
    targetIds: ['t1'],
    ...patch,
  }
}

describe('parseTimelapseRules', () => {
  it('narrows both LIVE rules', () => {
    const rules = parseTimelapseRules({ rules: [LIVE_FRONT_DOOR, LIVE_RETRO] })
    expect(rules).not.toBeNull()
    expect(rules!.map((r) => r.name)).toEqual(['Timelapse front door', 'Timelapse retro'])
    expect(rules![0]!.deviceIds).toEqual([101])
    expect(rules![0]!.schedule.timezone).toBe('Europe/Rome')
    expect(rules![0]!.lastGeneratedAt).toBe(1786598346092)
  })

  it('keeps the fields absent on the live rules ABSENT', () => {
    const rule = parseTimelapseRules({ rules: [LIVE_FRONT_DOOR] })![0]!
    expect(rule.denseCadenceSec).toBeUndefined()
    expect(rule.minDwellSec).toBeUndefined()
    expect(rule.template).toBeUndefined()
    expect(rule.reportClasses).toBeUndefined()
  })

  it('returns null when the hub answered something this bundle cannot read', () => {
    expect(parseTimelapseRules({ nonsense: true })).toBeNull()
    expect(
      parseTimelapseRules({
        rules: [{ ...LIVE_FRONT_DOOR, cadenceSec: 'fast' }],
      }),
    ).toBeNull()
  })

  it('an empty rule set is an ANSWER, not an unreadable one', () => {
    expect(parseTimelapseRules({ rules: [] })).toEqual([])
  })
})

describe('the live rules survive a round trip', () => {
  it('opening `Timelapse front door` and saving it unchanged sends an EMPTY patch', () => {
    const rule = parseTimelapseRules({ rules: [LIVE_FRONT_DOOR] })![0]!
    expect(buildTimelapsePatch(timelapseRuleToForm(rule), rule)).toEqual({})
  })

  it('opening `Timelapse retro` and saving it unchanged sends an EMPTY patch', () => {
    const rule = parseTimelapseRules({ rules: [LIVE_RETRO] })![0]!
    expect(buildTimelapsePatch(timelapseRuleToForm(rule), rule)).toEqual({})
  })

  it('a rename touches the NAME and nothing else — not the derived dense cadence', () => {
    const rule = parseTimelapseRules({ rules: [LIVE_FRONT_DOOR] })![0]!
    const patch = buildTimelapsePatch({ ...timelapseRuleToForm(rule), name: 'Front door' }, rule)
    expect(Object.keys(patch)).toEqual(['name'])
    // The trap: `denseCadenceSec` is ABSENT on this rule and means "derived".
    // Sending the derived number would pin it forever.
    expect('denseCadenceSec' in patch).toBe(false)
  })

  it('never sends the server-stamped generation state back', () => {
    const rule = parseTimelapseRules({ rules: [LIVE_FRONT_DOOR] })![0]!
    const patch = buildTimelapsePatch({ ...timelapseRuleToForm(rule), framerate: 24 }, rule)
    expect('generatedByDevice' in patch).toBe(false)
    expect('lastGeneratedAt' in patch).toBe(false)
    expect('id' in patch).toBe(false)
    expect(patch.framerate).toBe(24)
  })

  it('an explicit dense cadence IS sent, and clearing it goes back to derived', () => {
    const rule = parseTimelapseRules({ rules: [LIVE_FRONT_DOOR] })![0]!
    const state = timelapseRuleToForm(rule)
    const pinned = buildTimelapsePatch({ ...state, denseCadenceSec: 0.5 }, rule)
    expect(pinned.denseCadenceSec).toBe(0.5)

    const withDense = parseTimelapseRules({
      rules: [{ ...LIVE_FRONT_DOOR, denseCadenceSec: 0.5 }],
    })![0]!
    const cleared = buildTimelapsePatch(
      { ...timelapseRuleToForm(withDense), denseCadenceSec: undefined },
      withDense,
    )
    // The patch schema has no clear signal for this field, so going back to
    // "derived" is expressed as the derivation itself — and it must be VISIBLE
    // in the patch, never silently left pinned.
    expect(cleared.denseCadenceSec).toBe(derivedDenseCadenceSec(withDense.cadenceSec))
  })
})

describe('timelapseFormProblems', () => {
  it('accepts a minimal, produceable rule', () => {
    expect(timelapseFormProblems(form())).toEqual([])
    expect(isTimelapseFormValid(form())).toBe(true)
  })

  it('blocks a rule with no camera', () => {
    expect(timelapseFormProblems(form({ deviceIds: [] })).join(' ')).toMatch(/camera/i)
  })

  it('blocks a rule with NO SCHEDULE — a timelapse is defined by its window', () => {
    const problems = timelapseFormProblems(form({ schedule: undefined }))
    expect(problems.join(' ')).toMatch(/window/i)
    expect(isTimelapseFormValid(form({ schedule: undefined }))).toBe(false)
  })

  it('blocks a rule with no delivery target', () => {
    expect(timelapseFormProblems(form({ targetIds: [] })).join(' ')).toMatch(/target/i)
  })

  it('mirrors the server cadence guard: dense must be STRICTLY denser than base', () => {
    const problems = timelapseFormProblems(form({ cadenceSec: 30, denseCadenceSec: 30 }))
    expect(problems.join(' ')).toMatch(/strictly smaller/i)
    expect(timelapseFormProblems(form({ cadenceSec: 30, denseCadenceSec: 1 }))).toEqual([])
  })

  it('blocks the cadence / framerate values the hub would refuse', () => {
    expect(timelapseFormProblems(form({ cadenceSec: 1 })).join(' ')).toMatch(/cadence/i)
    expect(timelapseFormProblems(form({ framerate: 120 })).join(' ')).toMatch(/frame/i)
  })
})

describe('timelapseFormWarnings', () => {
  it('is silent on an ordinary rule', () => {
    expect(timelapseFormWarnings(form())).toEqual([])
  })

  it('says an inverted schedule covers the time OUTSIDE the windows', () => {
    const warnings = timelapseFormWarnings(
      form({
        schedule: {
          windows: [{ days: [1], startMinute: 0, endMinute: 420 }],
          invert: true,
        },
      }),
    )
    expect(warnings.join(' ')).toMatch(/outside/i)
  })

  it('says the dwell OVERRIDES an explicit dense cadence — it only ever densifies', () => {
    const warnings = timelapseFormWarnings(form({ denseCadenceSec: 1, minDwellSec: 1 }))
    expect(warnings.join(' ')).toMatch(/densif/i)
  })

  it('says which passages are too short to ever reach the dwell', () => {
    // The guarantee is capped by real footage: at the 0.1 s floor and 12 fps a
    // 5 s dwell needs a 6 s passage. Shorter ones get every frame that exists
    // and no more — never duplicated frames inventing motion.
    const warnings = timelapseFormWarnings(form({ minDwellSec: 5, framerate: 12 }))
    expect(warnings.join(' ')).toMatch(/shorter than 6/i)
  })
})

describe('the dense-cadence arithmetic the operator is tuning', () => {
  it('derives the dense cadence the renderer would derive', () => {
    expect(derivedDenseCadenceSec(30)).toBe(1)
    expect(derivedDenseCadenceSec(60)).toBe(2)
    // Floored at 1s — the derivation never goes below it.
    expect(derivedDenseCadenceSec(15)).toBe(1)
  })

  it('answers "how long does a 7 second pass last on screen?"', () => {
    // (rangeSec / denseCadenceSec) / framerate — the schema's own formula.
    expect(denseRangeOutputSeconds(7, 1, 12)).toBeCloseTo(0.58, 2)
    expect(denseRangeOutputSeconds(7, 0.5, 12)).toBeCloseTo(1.17, 2)
  })
})

describe('display helpers', () => {
  it('reads the live overnight window as OVERNIGHT, not as a same-day range', () => {
    const rule = parseTimelapseRules({ rules: [LIVE_FRONT_DOOR] })![0]!
    const label = timelapseScheduleLabel(rule.schedule)
    expect(label).toMatch(/21:00–07:00/)
    expect(label).toMatch(/overnight/i)
  })

  it('says NEVER for a rule that has produced nothing yet', () => {
    expect(timelapseLastGeneratedLabel(undefined, 1_786_600_000_000)).toMatch(/never/i)
    expect(timelapseLastGeneratedLabel(1_786_600_000_000 - 3_600_000, 1_786_600_000_000)).toMatch(
      /1h ago/,
    )
  })
})

describe('buildTimelapseCreateInput', () => {
  it('omits every optional field the form does not express', () => {
    const input = buildTimelapseCreateInput(form())
    expect(input.template).toBeUndefined()
    expect(input.denseCadenceSec).toBeUndefined()
    expect(input.minDwellSec).toBeUndefined()
    expect(input.reportClasses).toBeUndefined()
    expect(input.targets).toEqual([{ targetId: 't1' }])
  })

  it('keeps an EMPTY caption, which means "the frame, no caption"', () => {
    // `''` is a reachable, distinct answer — not the same as "never set one".
    const input = buildTimelapseCreateInput(form({ previewText: '', previewTextSet: true }))
    expect(input.previewText).toBe('')
  })
})

describe('the editor tabs', () => {
  it('claims EVERY form field exactly once', () => {
    const claimed = NC_TIMELAPSE_TABS.flatMap((tab) => tab.fields)
    const all = Object.keys(emptyTimelapseForm()).toSorted()
    expect(claimed.toSorted()).toEqual(all)
    expect(new Set(claimed).size).toBe(claimed.length)
  })

  it('opens on the tab an operator meets first, and refuses an unknown key', () => {
    expect(NC_TIMELAPSE_TABS[0]?.key).toBe(DEFAULT_TIMELAPSE_TAB)
    expect(parseTimelapseTab('sampling')).toBe('sampling')
    expect(parseTimelapseTab('nope')).toBeUndefined()
  })
})

describe('parseTimelapseTestOutcome', () => {
  it('narrows a produced run', () => {
    expect(
      parseTimelapseTestOutcome({
        produced: 1,
        exportId: 'x',
        coveragePercent: 92,
        enqueued: 1,
      }),
    ).toEqual({ produced: 1, exportId: 'x', coveragePercent: 92, enqueued: 1 })
  })

  it('keeps the producer’s own error instead of inventing a verdict', () => {
    expect(parseTimelapseTestOutcome({ produced: 0, error: 'no closed window' })?.error).toBe(
      'no closed window',
    )
  })

  it('is null on an answer this bundle cannot read', () => {
    expect(parseTimelapseTestOutcome({ ok: true })).toBeNull()
  })
})
