/**
 * The Summaries tab's pure half.
 *
 * Three things are being pinned here, and each one has a live failure behind it:
 *
 *  1. **The bridge answer is `z.unknown()`** at the cap boundary, so every field
 *     is narrowed by hand. A hub that answers a shape this bundle does not know
 *     yields `null` and the tab says so — it never renders an empty table, which
 *     reads as "my rules are gone".
 *  2. **The patch is a DIFF.** `nc.upsertSummaryRule` merges
 *     `{...existing, ...patch}`, so any key the UI sends overwrites the stored
 *     one, and a key it omits is preserved. That is why a rename emits exactly
 *     `{name}` — and why, now that `ai` IS editable (P2), the form has to carry
 *     every field of the section: a form that expressed only half of it would
 *     erase the other half on the first save.
 *  3. **A rule that cannot produce does not save.** The reasons mirror the
 *     engine's own gates (no camera, no target, a scheduled digest with no
 *     window, an AI budget larger than the tile budget), and they are the same
 *     list the dialog prints.
 */
import { describe, expect, it } from 'vitest'

import {
  buildSummaryCreateInput,
  buildSummaryPatch,
  DEFAULT_SUMMARY_TAB,
  emptySummaryForm,
  isEditableSummaryRule,
  isSummaryFormValid,
  NC_SUMMARY_TABS,
  parseSummaryRules,
  parseSummaryTab,
  parseSummaryTestOutcome,
  SUMMARY_TEST_LOOKBACK_MS,
  type SummaryFormState,
  type SummaryRuleView,
  summaryFilterLabel,
  summaryFormProblems,
  summaryFormWarnings,
  summaryLastGeneratedLabel,
  summaryRuleToForm,
  summaryTestWindow,
  summaryWindowLabel,
} from '../notification-summaries.helpers'

/** A complete, valid wire rule as `nc.listSummaryRules` answers it. */
const WIRE_MOTION = {
  id: 'sum_1',
  name: 'Night sweep',
  enabled: true,
  deviceIds: [101, 102],
  window: { kind: 'motion', quietSeconds: 300, maxWindowSeconds: 3600 },
  maxTiles: 9,
  maxAiImages: 6,
  rank: 'importance',
  barrierSeconds: 120,
  targets: [{ targetId: 't1' }],
  deliverEmpty: false,
  priority: 3,
  createdBy: 'admin',
  createdAt: 1000,
  updatedAt: 2000,
  readOnly: false,
}

const WIRE_SCHEDULE = {
  ...WIRE_MOTION,
  id: 'sum_2',
  name: 'Morning digest',
  window: {
    kind: 'schedule',
    schedule: {
      windows: [{ days: [1, 2, 3, 4, 5], startMinute: 0, endMinute: 420 }],
    },
  },
  filters: { classes: ['person'], minImportance: 0.4 },
  template: { title: 'Overnight', body: '{{count}} passages' },
  captionText: 'Overnight',
  generatedAt: 5000,
  ai: { enabled: true, prompt: 'what happened?', language: 'it' },
}

function form(patch: Partial<SummaryFormState> = {}): SummaryFormState {
  return {
    ...emptySummaryForm(),
    name: 'Digest',
    deviceIds: [101, 102],
    targetIds: ['t1'],
    ...patch,
  }
}

describe('parseSummaryRules', () => {
  it('narrows a well-formed answer, keeping the window union intact', () => {
    const rules = parseSummaryRules({ rules: [WIRE_MOTION, WIRE_SCHEDULE] })
    expect(rules).not.toBeNull()
    expect(rules).toHaveLength(2)
    const motion = rules![0]!
    expect(motion.window).toEqual({
      kind: 'motion',
      quietSeconds: 300,
      maxWindowSeconds: 3600,
    })
    const scheduled = rules![1]!
    expect(scheduled.window.kind).toBe('schedule')
    expect(scheduled.filters?.classes).toEqual(['person'])
    expect(scheduled.generatedAt).toBe(5000)
  })

  it('narrows the whole AI section, not merely its presence', () => {
    const rules = parseSummaryRules({ rules: [WIRE_MOTION, WIRE_SCHEDULE] })!
    expect(rules[0]!.ai).toBeUndefined()
    expect(rules[1]!.ai).toEqual({ enabled: true, prompt: 'what happened?', language: 'it' })
  })

  it('refuses an AI section it cannot read rather than silently dropping it', () => {
    // Dropping it would be worse than refusing: the editor would then WRITE an
    // `ai` it never read, erasing whatever the hub actually holds.
    expect(parseSummaryRules({ rules: [{ ...WIRE_MOTION, ai: { enabled: 'yes' } }] })).toBeNull()
  })

  it('returns null when the hub answered a shape this bundle cannot read', () => {
    expect(parseSummaryRules({ nonsense: true })).toBeNull()
    expect(parseSummaryRules(null)).toBeNull()
    expect(parseSummaryRules({ rules: [{ ...WIRE_MOTION, deviceIds: ['101'] }] })).toBeNull()
  })

  it('keeps a rule whose window kind this build does not know — flagged, never dropped', () => {
    // A newer hub growing a third window kind must not make the whole tab
    // unreadable, and the rule must not disappear from a list the operator
    // uses to find it. It renders, and it refuses to be edited.
    const rules = parseSummaryRules({
      rules: [{ ...WIRE_MOTION, window: { kind: 'daily', at: '07:00' } }],
    })
    expect(rules).not.toBeNull()
    expect(rules![0]!.window).toEqual({ kind: 'unsupported', raw: 'daily' })
    expect(isEditableSummaryRule(rules![0]!)).toBe(false)
  })

  it('an empty rule set is an ANSWER, not an unreadable one', () => {
    expect(parseSummaryRules({ rules: [] })).toEqual([])
  })
})

describe('summaryRuleToForm / buildSummaryCreateInput', () => {
  it('round-trips every authored field of a scheduled rule', () => {
    const rule = parseSummaryRules({ rules: [WIRE_SCHEDULE] })![0]!
    if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
    const state = summaryRuleToForm(rule)
    expect(state.name).toBe('Morning digest')
    expect(state.windowKind).toBe('schedule')
    expect(state.schedule?.windows).toHaveLength(1)
    expect(state.classes).toEqual(['person'])
    expect(state.minImportance).toBe(0.4)
    expect(state.templateTitle).toBe('Overnight')
    expect(state.captionText).toBe('Overnight')

    const input = buildSummaryCreateInput(state)
    expect(input.window).toEqual(rule.window)
    expect(input.filters).toEqual({ classes: ['person'], minImportance: 0.4 })
    expect(input.template).toEqual({
      title: 'Overnight',
      body: '{{count}} passages',
    })
    expect(input.targets).toEqual([{ targetId: 't1' }])
  })

  it('omits an empty filter set entirely rather than sending empty arrays', () => {
    const input = buildSummaryCreateInput(form())
    expect(input.filters).toBeUndefined()
    expect(input.template).toBeUndefined()
    expect(input.captionText).toBeUndefined()
  })

  it('never invents an `ai` section on a new rule', () => {
    expect('ai' in buildSummaryCreateInput(form())).toBe(false)
  })

  /**
   * ONLY IMAGES, by default and by migration.
   *
   * The operator's report: the mosaic has no way to turn text off, and he wants
   * pictures. `none` is therefore the default a NEW rule opens on AND what an
   * existing rule with no `captions` key reads as — the hub materialises the
   * same default (`NcSummaryRuleInputSchema`), so neither side has to backfill.
   */
  it('a NEW digest carries no text on its mosaic', () => {
    expect(emptySummaryForm().mosaicCaptions).toBe('none')
    expect(buildSummaryCreateInput(form()).captions).toBe('none')
  })

  it("a NEW digest opens on the ADDON's tile default (12), not a stale 9", () => {
    // `NC_SUMMARY_DEFAULT_TILES` in addon-post-analysis `summary/summary-rule.ts`.
    // The admin SENDS this value on create, so a stale copy retunes every new
    // rule away from the hub's default (Plan D Task 13 review).
    expect(emptySummaryForm().maxTiles).toBe(12)
    expect(buildSummaryCreateInput(form()).maxTiles).toBe(12)
  })

  it('a NEW motion digest is 1 minute quiet and a 5 minute ceiling', () => {
    expect(emptySummaryForm().quietSeconds).toBe(60)
    expect(emptySummaryForm().maxWindowSeconds).toBe(300)
  })

  it('an EXISTING rule with no captions key reads as none, not as the old behaviour', () => {
    expect(WIRE_MOTION).not.toHaveProperty('captions')
    const rule = parseSummaryRules({ rules: [WIRE_MOTION] })![0]!
    expect(rule.captions).toBe('none')
    if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
    expect(summaryRuleToForm(rule).mosaicCaptions).toBe('none')
  })

  it('round-trips a rule that ASKED for the words back', () => {
    const rule = parseSummaryRules({ rules: [{ ...WIRE_MOTION, captions: 'all' }] })![0]!
    expect(rule.captions).toBe('all')
    if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
    const state = summaryRuleToForm(rule)
    expect(state.mosaicCaptions).toBe('all')
    expect(buildSummaryCreateInput(state).captions).toBe('all')
  })

  it('refuses a captions mode it cannot render rather than coercing it to none', () => {
    // Coercing would rewrite a rule authored on a newer hub the moment the
    // operator renamed it — the same trap `parseWindow` refuses for `kind`.
    expect(parseSummaryRules({ rules: [{ ...WIRE_MOTION, captions: 'footer' }] })).toBeNull()
  })

  /**
   * PARKED objects, off by default and by migration.
   *
   * The operator's report: the digests were filling up with stationary tracks
   * (D161 persists a promoted track instead of forgetting it, so the parked car
   * now reaches every window it overlaps). Off is the default a NEW rule opens
   * on AND the reading of a rule with no key — the hub reads `=== true`, so
   * neither side has to backfill anything.
   */
  describe('parked objects', () => {
    it('a NEW digest asks for passages only, and sends no key for it', () => {
      expect(emptySummaryForm().includeStationary).toBe(false)
      // The default must not conjure a `filters` object on a rule that has none.
      expect(buildSummaryCreateInput(form()).filters).toBeUndefined()
    })

    it('an EXISTING rule with no key reads as off, not as the old behaviour', () => {
      expect(WIRE_MOTION).not.toHaveProperty('filters.includeStationary')
      const rule = parseSummaryRules({ rules: [WIRE_MOTION] })![0]!
      if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
      expect(summaryRuleToForm(rule).includeStationary).toBe(false)
    })

    it('round-trips a rule that ASKED for them', () => {
      const rule = parseSummaryRules({
        rules: [{ ...WIRE_MOTION, filters: { includeStationary: true } }],
      })![0]!
      expect(rule.filters?.includeStationary).toBe(true)
      if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
      const state = summaryRuleToForm(rule)
      expect(state.includeStationary).toBe(true)
      expect(buildSummaryCreateInput(state).filters).toEqual({ includeStationary: true })
    })

    it('turning it on is the ONLY key the patch carries', () => {
      const rule = parseSummaryRules({ rules: [WIRE_MOTION] })![0]!
      if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
      const state = summaryRuleToForm(rule)
      const patch = buildSummaryPatch({ ...state, includeStationary: true }, rule)
      expect(Object.keys(patch)).toEqual(['filters'])
      expect(patch.filters).toEqual({ includeStationary: true })
    })

    it('refuses a non-boolean rather than coercing it', () => {
      expect(
        parseSummaryRules({ rules: [{ ...WIRE_MOTION, filters: { includeStationary: 'yes' } }] }),
      ).toBeNull()
    })
  })

  it('every AI field the schema has is claimed by the form — none can be erased', () => {
    // The property that makes writing `ai` safe at all. A field the form does
    // not carry is a field the next save deletes, silently.
    const full = buildSummaryCreateInput({
      ...form(),
      aiEnabled: true,
      aiProfileId: 'p1',
      aiPrompt: 'q',
      aiLanguage: 'it',
      aiMaxImagePx: 512,
      aiTimeoutSeconds: 30,
      aiOnFailure: 'skip',
    })
    expect(full.ai).toEqual({
      enabled: true,
      profileId: 'p1',
      prompt: 'q',
      language: 'it',
      maxImagePx: 512,
      timeoutMs: 30_000,
      onFailure: 'skip',
    })
  })
})

describe('buildSummaryPatch', () => {
  const scheduled = (): SummaryRuleView => parseSummaryRules({ rules: [WIRE_SCHEDULE] })![0]!

  it('sends ONLY what changed', () => {
    const rule = scheduled()
    if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
    const state = summaryRuleToForm(rule)
    const patch = buildSummaryPatch({ ...state, name: 'Renamed' }, rule)
    expect(Object.keys(patch)).toEqual(['name'])
    expect(patch.name).toBe('Renamed')
  })

  it('names captions only when the operator changed them', () => {
    const rule = scheduled()
    if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
    const state = summaryRuleToForm(rule)
    expect('captions' in buildSummaryPatch(state, rule)).toBe(false)
    expect(buildSummaryPatch({ ...state, mosaicCaptions: 'all' }, rule).captions).toBe('all')
  })

  it('a rename does not touch the AI section — the section round-trips EXACTLY', () => {
    // The failure this replaces is now the opposite one: the editor WRITES
    // `ai`, so a form that lost a field on hydration would erase it on the next
    // save. The diff proves the round-trip rather than describing it.
    const rule = scheduled()
    if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
    const state = summaryRuleToForm(rule)
    const patch = buildSummaryPatch({ ...state, name: 'Renamed', maxTiles: 4 }, rule)
    expect('ai' in patch).toBe(false)
    expect(Object.keys(patch).toSorted()).toEqual(['maxTiles', 'name'])
  })

  it('WRITES the AI section the operator authored', () => {
    const rule = scheduled()
    if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
    const state = summaryRuleToForm(rule)
    expect(state.aiEnabled).toBe(true)
    expect(state.aiPrompt).toBe('what happened?')
    expect(state.aiLanguage).toBe('it')
    const patch = buildSummaryPatch(
      { ...state, aiProfileId: 'mac-lmstudio-qwen3vl', aiOnFailure: 'skip' },
      rule,
    )
    expect(patch.ai).toEqual({
      enabled: true,
      prompt: 'what happened?',
      language: 'it',
      profileId: 'mac-lmstudio-qwen3vl',
      onFailure: 'skip',
    })
  })

  it('CLEARS the section with an explicit null when the operator emptied it', () => {
    const rule = scheduled()
    if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
    const state = summaryRuleToForm(rule)
    const patch = buildSummaryPatch(
      { ...state, aiEnabled: false, aiPrompt: '', aiLanguage: '' },
      rule,
    )
    expect(patch.ai).toBeNull()
  })

  it('keeps a section that is CONFIGURED but switched off', () => {
    // Off is not absent: an operator who turns AI off for a week must find his
    // prompt where he left it.
    const rule = scheduled()
    if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
    const state = summaryRuleToForm(rule)
    const patch = buildSummaryPatch({ ...state, aiEnabled: false }, rule)
    expect(patch.ai).toEqual({ enabled: false, prompt: 'what happened?', language: 'it' })
  })

  it('the timeout is authored in SECONDS and stored in milliseconds', () => {
    const patch = buildSummaryCreateInput({ ...form(), aiEnabled: true, aiTimeoutSeconds: 240 })
    expect(patch.ai?.timeoutMs).toBe(240_000)
  })

  it('clears filters with an explicit null when the operator removed the last one', () => {
    const rule = scheduled()
    if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
    const state = summaryRuleToForm(rule)
    const patch = buildSummaryPatch({ ...state, classes: [], minImportance: undefined }, rule)
    expect(patch.filters).toBeNull()
  })

  it('an untouched form produces an EMPTY patch', () => {
    const rule = scheduled()
    if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
    expect(buildSummaryPatch(summaryRuleToForm(rule), rule)).toEqual({})
  })

  it('treats a reordered camera list as a change — the first camera is the digest owner', () => {
    const rule = parseSummaryRules({ rules: [WIRE_MOTION] })![0]!
    if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')
    const state = summaryRuleToForm(rule)
    expect(buildSummaryPatch({ ...state, deviceIds: [102, 101] }, rule).deviceIds).toEqual([
      102, 101,
    ])
  })
})

describe('summaryFormProblems', () => {
  it('accepts a minimal, deliverable rule', () => {
    expect(summaryFormProblems(form())).toEqual([])
    expect(isSummaryFormValid(form())).toBe(true)
  })

  it('blocks a rule with no camera — a digest of nothing is not a digest', () => {
    const problems = summaryFormProblems(form({ deviceIds: [] }))
    expect(problems.join(' ')).toMatch(/camera/i)
    expect(isSummaryFormValid(form({ deviceIds: [] }))).toBe(false)
  })

  it('blocks a rule with no delivery target', () => {
    expect(summaryFormProblems(form({ targetIds: [] })).join(' ')).toMatch(/target/i)
  })

  it('blocks an unnamed rule', () => {
    expect(summaryFormProblems(form({ name: '  ' })).join(' ')).toMatch(/name/i)
  })

  it('blocks a SCHEDULED digest with no time window — it would never close', () => {
    const problems = summaryFormProblems(form({ windowKind: 'schedule', schedule: undefined }))
    expect(problems.join(' ')).toMatch(/window/i)
  })

  it('mirrors the server budget invariant: AI images may not exceed tiles', () => {
    const problems = summaryFormProblems(form({ maxTiles: 4, maxAiImages: 6 }))
    expect(problems.join(' ')).toMatch(/cannot exceed/i)
  })

  it('blocks a class filter that excludes everything it includes', () => {
    const problems = summaryFormProblems(form({ classes: ['person'], classesExclude: ['person'] }))
    expect(problems.join(' ')).toMatch(/no track can ever become a tile/i)
  })

  it('blocks a motion window outside the bounds the hub would refuse', () => {
    expect(summaryFormProblems(form({ quietSeconds: 5 })).join(' ')).toMatch(/quiet/i)
    expect(summaryFormProblems(form({ maxWindowSeconds: 10 })).join(' ')).toMatch(/longest/i)
  })
})

describe('summaryFormWarnings', () => {
  it('says when the quiet period can never close the window', () => {
    // Not a block: the window still closes at the ceiling and still delivers.
    // It is the quiet period that is dead, and silence about it is what makes
    // an operator think the setting did something.
    const warnings = summaryFormWarnings(form({ quietSeconds: 3600, maxWindowSeconds: 3600 }))
    expect(warnings.join(' ')).toMatch(/ceiling/i)
    expect(summaryFormProblems(form({ quietSeconds: 3600, maxWindowSeconds: 3600 }))).toEqual([])
  })

  it('says when a class is both included and excluded but the rule still works', () => {
    const warnings = summaryFormWarnings(
      form({ classes: ['person', 'vehicle'], classesExclude: ['vehicle'] }),
    )
    expect(warnings.join(' ')).toMatch(/vehicle/)
  })

  it('says a ONE-camera digest is probably the wrong tool, without refusing it', () => {
    const warnings = summaryFormWarnings(form({ deviceIds: [101] }))
    expect(warnings.join(' ')).toMatch(/multi-camera/i)
    expect(summaryFormProblems(form({ deviceIds: [101] }))).toEqual([])
  })

  it('is silent on an ordinary rule', () => {
    expect(summaryFormWarnings(form())).toEqual([])
  })
})

describe('display helpers', () => {
  it('describes both window kinds in the operator’s words', () => {
    expect(
      summaryWindowLabel({
        kind: 'motion',
        quietSeconds: 300,
        maxWindowSeconds: 3600,
      }),
    ).toBe('Motion · 5m quiet · max 1h')
    expect(
      summaryWindowLabel({
        kind: 'schedule',
        schedule: { windows: [{ days: [1], startMinute: 0, endMinute: 420 }] },
      }),
    ).toMatch(/^Schedule/)
    expect(summaryWindowLabel({ kind: 'unsupported', raw: 'daily' })).toMatch(/daily/)
  })

  it('says NEVER, not "—", for a rule that has produced nothing yet', () => {
    expect(summaryLastGeneratedLabel(undefined, 1_786_000_000_000)).toMatch(/never/i)
    expect(summaryLastGeneratedLabel(1_786_000_000_000 - 3_600_000, 1_786_000_000_000)).toMatch(
      /1h ago/,
    )
  })

  it('summarises the filters for the table, and says "all tracks" when there are none', () => {
    expect(summaryFilterLabel(undefined)).toMatch(/all/i)
    expect(summaryFilterLabel({ classes: ['person'], zones: ['z1'] })).toMatch(/person/)
  })

  it('aims the Test button at an explicit recent window', () => {
    const window = summaryTestWindow(1_000_000_000)
    expect(window.windowEndMs).toBe(1_000_000_000)
    expect(window.windowStartMs).toBe(1_000_000_000 - SUMMARY_TEST_LOOKBACK_MS)
  })
})

describe('parseSummaryTestOutcome', () => {
  it('narrows a produced run', () => {
    const outcome = parseSummaryTestOutcome({
      produced: 1,
      tiles: 6,
      cameras: 2,
      matched: 14,
      enqueued: 1,
      windowStartMs: 10,
      windowEndMs: 20,
    })
    expect(outcome).toEqual({
      produced: 1,
      tiles: 6,
      cameras: 2,
      matched: 14,
      enqueued: 1,
      windowStartMs: 10,
      windowEndMs: 20,
    })
  })

  it('keeps the producer’s own error string instead of inventing a verdict', () => {
    const outcome = parseSummaryTestOutcome({
      produced: 0,
      error: 'no window has closed recently',
    })
    expect(outcome?.error).toBe('no window has closed recently')
  })

  it('is null on an answer this bundle cannot read', () => {
    expect(parseSummaryTestOutcome({ ok: true })).toBeNull()
  })
})

describe('the editor tabs', () => {
  it('claims EVERY form field exactly once', () => {
    // The same guard `NC_RULE_TABS` carries, for the same reason: splitting one
    // scrolling form into tabs is exactly what makes it easy to leave a field
    // with no home. The form still round-trips it, so the loss is silent —
    // the operator simply can no longer edit it.
    const claimed = NC_SUMMARY_TABS.flatMap((tab) => tab.fields)
    const all = Object.keys(emptySummaryForm()).toSorted()
    expect(claimed.toSorted()).toEqual(all)
    expect(new Set(claimed).size).toBe(claimed.length)
  })

  it('opens on the tab an operator meets first, and refuses an unknown key', () => {
    expect(NC_SUMMARY_TABS[0]?.key).toBe(DEFAULT_SUMMARY_TAB)
    expect(parseSummaryTab('window')).toBe('window')
    expect(parseSummaryTab('nope')).toBeUndefined()
  })

  it('every tab has a label — a nameless tab is a tab nobody opens', () => {
    for (const tab of NC_SUMMARY_TABS) expect(tab.label.length).toBeGreaterThan(0)
  })
})

describe('what a Test run reports about the AI pass', () => {
  it('reads the sentence, the failure and the frame count', () => {
    const out = parseSummaryTestOutcome({
      produced: 1,
      tiles: 4,
      aiText: 'Two people crossed the yard.',
      aiImages: 4,
    })
    expect(out?.aiText).toBe('Two people crossed the yard.')
    expect(out?.aiImages).toBe(4)
  })

  it('a withheld window is reported as WITHHELD, never as an empty one', () => {
    const out = parseSummaryTestOutcome({ produced: 0, skippedByAi: true, aiFailure: 'timeout' })
    expect(out?.skippedByAi).toBe(true)
    expect(out?.aiFailure).toBe('timeout')
  })
})
