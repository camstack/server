/**
 * D692 Task 18 — the admin editor's "Immediate, grouped" trigger choice.
 *
 * `NcDelivery` does not change: the choice is a UI-only value that maps onto
 * `delivery: 'immediate'` + `groupingSec`. Round trip, `clear`, the default, the
 * places the option is hidden, and the choices the hub's save guard (T16) would
 * refuse — which the editor explains instead of letting the save fail.
 */
import type { NcConfirm, NcRule } from '@camstack/types'
import {
  NC_CONDITION_CATALOG,
  NC_GROUPING_DEFAULT_SEC,
  NC_GROUPING_MAX_SEC,
  NC_GROUPING_MIN_SEC,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  applyDeliveryChoice,
  buildRuleClears,
  buildRuleInput,
  deliveryChoiceOf,
  deliveryChoicesFor,
  emptyRuleForm,
  isRuleFormValid,
  parseDeliveryChoice,
  parseGroupingSec,
  type NcRuleFormState,
  ruleDeliveryLabel,
  ruleFormProblems,
  ruleSeedForSection,
  ruleToForm,
} from '../notification-rules.helpers'

function storedRule(overrides: Partial<NcRule> = {}): NcRule {
  return {
    id: 'r1',
    name: 'Front door',
    enabled: true,
    disabledTargetIds: [],
    delivery: 'immediate',
    conditions: { classes: ['person'] },
    targets: [{ targetId: 't1' }],
    media: { attach: 'best' },
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    priority: 3,
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function formFor(overrides: Partial<NcRuleFormState> = {}): NcRuleFormState {
  return { ...emptyRuleForm('immediate'), name: 'x', targetIds: ['t'], ...overrides }
}

const CONFIRM_ON: NcConfirm = {
  enabled: true,
  timeoutMs: 8_000,
  onTimeout: 'fire',
  maxImagePx: 448,
}

describe('groupingSec — round trip', () => {
  it('a stored grouped rule survives load -> form -> save', () => {
    const form = ruleToForm(storedRule({ groupingSec: 30 }))
    expect(form.groupingSec).toBe(30)
    expect(deliveryChoiceOf(form)).toBe('immediate-grouped')
    const input = buildRuleInput(form, undefined, NC_CONDITION_CATALOG)
    expect(input.delivery).toBe('immediate')
    expect(input.groupingSec).toBe(30)
    expect(buildRuleClears(form, NC_CONDITION_CATALOG)).not.toContain('groupingSec')
  })

  it('a plain immediate rule writes no groupingSec and CLEARS the stored one', () => {
    const grouped = ruleToForm(storedRule({ groupingSec: 30 }))
    const plain = applyDeliveryChoice(grouped, 'immediate')
    expect(plain.groupingSec).toBeUndefined()
    const input = buildRuleInput(plain, undefined, NC_CONDITION_CATALOG)
    expect('groupingSec' in input).toBe(false)
    expect(buildRuleClears(plain, NC_CONDITION_CATALOG)).toContain('groupingSec')
  })

  it('moving to another trigger drops it (the hub refuses groupingSec off immediate)', () => {
    const moved = applyDeliveryChoice(ruleToForm(storedRule({ groupingSec: 30 })), 'track-end')
    expect(moved.delivery).toBe('track-end')
    expect(moved.groupingSec).toBeUndefined()
    expect(buildRuleClears(moved, NC_CONDITION_CATALOG)).toContain('groupingSec')
  })

  it('a stale groupingSec on a rule that cannot group is never sent, and is cleared', () => {
    // A rule stored before the save guard: track-end carrying groupingSec.
    const form = ruleToForm(storedRule({ delivery: 'track-end', groupingSec: 30 }))
    expect(deliveryChoiceOf(form)).toBe('track-end')
    const input = buildRuleInput(form, undefined, NC_CONDITION_CATALOG)
    expect('groupingSec' in input).toBe(false)
    expect(buildRuleClears(form, NC_CONDITION_CATALOG)).toContain('groupingSec')
  })
})

describe('choosing the grouped option', () => {
  it('pre-fills NC_GROUPING_DEFAULT_SEC (20) on a fresh form', () => {
    const next = applyDeliveryChoice(emptyRuleForm('immediate'), 'immediate-grouped')
    expect(next.delivery).toBe('immediate')
    expect(next.groupingSec).toBe(NC_GROUPING_DEFAULT_SEC)
    expect(NC_GROUPING_DEFAULT_SEC).toBe(20)
  })

  it('keeps the seconds the operator already chose', () => {
    const next = applyDeliveryChoice(formFor({ groupingSec: 45 }), 'immediate-grouped')
    expect(next.groupingSec).toBe(45)
  })

  it('from track-end it moves the rule to immediate', () => {
    const next = applyDeliveryChoice(emptyRuleForm('track-end'), 'immediate-grouped')
    expect(next.delivery).toBe('immediate')
    expect(next.groupingSec).toBe(NC_GROUPING_DEFAULT_SEC)
  })

  it('parses a select string through the offered list, ignoring a stray value', () => {
    expect(parseDeliveryChoice('immediate-grouped')).toBe('immediate-grouped')
    expect(parseDeliveryChoice('track-end')).toBe('track-end')
    expect(parseDeliveryChoice('nope')).toBeUndefined()
  })
})

describe('clear keys the editor no longer authors', () => {
  it('buildRuleClears never contains waitForEnhancement or groupIdleSec', () => {
    for (const form of [emptyRuleForm('immediate'), formFor({ groupingSec: 20 })]) {
      const clears = buildRuleClears(form, NC_CONDITION_CATALOG)
      expect(clears).not.toContain('waitForEnhancement')
      expect(clears).not.toContain('groupIdleSec')
    }
  })

  it('the form no longer carries waitForEnhancement, and a save sends neither retired key', () => {
    // A stored rule cannot carry either key any more (the hub projects them on read, D692 §9).
    expect('waitForEnhancement' in emptyRuleForm('immediate')).toBe(false)
    const form = ruleToForm(storedRule())
    const input = buildRuleInput(form, undefined, NC_CONDITION_CATALOG)
    expect('waitForEnhancement' in input).toBe(false)
    expect('groupIdleSec' in input).toBe(false)
  })

  it('does not re-emit a stored groupIdleSec (the preserved set no longer has it)', () => {
    const input = buildRuleInput(
      ruleToForm(storedRule()),
      { confirm: CONFIRM_ON },
      NC_CONDITION_CATALOG,
    )
    expect('groupIdleSec' in input).toBe(false)
    expect(input.confirm).toEqual(CONFIRM_ON)
  })
})

describe('where the option is offered', () => {
  const values = (form: NcRuleFormState): readonly string[] =>
    deliveryChoicesFor(form).map((o) => o.value)

  it('is offered on a detection rule', () => {
    expect(values(emptyRuleForm('immediate'))).toContain('immediate-grouped')
    expect(values(emptyRuleForm('track-end'))).toContain('immediate-grouped')
  })

  it('is absent for a sound seed (the audio section)', () => {
    const seed = ruleSeedForSection('audio')
    const form = emptyRuleForm(seed.delivery, seed.conditions)
    expect(values(form)).not.toContain('immediate-grouped')
    expect(values(form)).toContain('immediate')
  })

  it('is absent once a sound condition is added to the rule being edited', () => {
    const form = formFor({
      conditions: { audio: { labels: ['dog-bark'], hitPercent: 50, samplingSeconds: 5 } },
    })
    expect(values(form)).not.toContain('immediate-grouped')
  })

  it('is absent for every non-detection section: occupancy, sensor, system', () => {
    for (const section of ['occupancy', 'sensor', 'system', 'device-events', 'alarm'] as const) {
      const seed = ruleSeedForSection(section)
      expect(values(emptyRuleForm(seed.delivery, seed.conditions))).not.toContain(
        'immediate-grouped',
      )
    }
    expect(values(emptyRuleForm('package-event'))).not.toContain('immediate-grouped')
  })

  it('a sound rule never sends groupingSec, even one left on the form', () => {
    const seed = ruleSeedForSection('audio')
    const form = {
      ...emptyRuleForm(seed.delivery, seed.conditions),
      groupingSec: 20,
    }
    expect(deliveryChoiceOf(form)).toBe('immediate')
    expect('groupingSec' in buildRuleInput(form, undefined, NC_CONDITION_CATALOG)).toBe(false)
    expect(buildRuleClears(form, NC_CONDITION_CATALOG)).toContain('groupingSec')
  })

  it('lists every other trigger unchanged and in order', () => {
    expect(values(emptyRuleForm('immediate'))).toEqual([
      'immediate',
      'immediate-grouped',
      'track-end',
      'device-event',
      'package-event',
      'system-event',
    ])
  })
})

describe('the list column', () => {
  it('shows "Immediate, grouped · 20 s" for a grouped rule', () => {
    expect(ruleDeliveryLabel(storedRule({ groupingSec: 20 }))).toBe('Immediate, grouped · 20 s')
  })

  it('shows the plain label otherwise', () => {
    expect(ruleDeliveryLabel(storedRule())).toBe('Immediate')
    expect(ruleDeliveryLabel(storedRule({ delivery: 'track-end', groupingSec: 20 }))).toBe(
      'Track end',
    )
  })

  it('takes the operator-language label for the grouped choice', () => {
    expect(ruleDeliveryLabel(storedRule({ groupingSec: 20 }), 'Immediata raggruppata')).toBe(
      'Immediata raggruppata · 20 s',
    )
  })
})

describe('the seconds are bounded like the hub (5..60)', () => {
  it('parses a whole number and ignores everything else', () => {
    expect(parseGroupingSec('30')).toBe(30)
    expect(parseGroupingSec('12.7')).toBe(12)
    expect(parseGroupingSec('')).toBeUndefined()
    expect(parseGroupingSec('abc')).toBeUndefined()
    expect(parseGroupingSec('-3')).toBeUndefined()
  })

  it('blocks a save outside the bounds, with a sentence', () => {
    for (const bad of [NC_GROUPING_MIN_SEC - 1, NC_GROUPING_MAX_SEC + 1]) {
      const form = formFor({ groupingSec: bad })
      expect(ruleFormProblems(form).join(' ')).toMatch(/5 and 60/)
      expect(isRuleFormValid(form)).toBe(false)
    }
    for (const ok of [NC_GROUPING_MIN_SEC, NC_GROUPING_DEFAULT_SEC, NC_GROUPING_MAX_SEC]) {
      expect(isRuleFormValid(formFor({ groupingSec: ok }))).toBe(true)
    }
  })

  it('does not judge seconds on a rule that is not grouped', () => {
    expect(isRuleFormValid(formFor({ delivery: 'track-end', groupingSec: 3 }))).toBe(true)
  })
})

describe('the grouped confirm refusal (T16), explained before the save', () => {
  const withExpect = (expect: NonNullable<NcConfirm['expect']>): Pick<NcRule, 'confirm'> => ({
    confirm: { ...CONFIRM_ON, expect },
  })

  it('blocks a grouped rule whose AI confirm expects more than one subject per tile', () => {
    const form = formFor({ groupingSec: 20 })
    for (const confirm of [
      withExpect({ op: '>=', count: 2 }),
      withExpect({ op: '==', count: 2 }),
      withExpect({ op: '>', count: 1 }),
      withExpect({ op: '<', count: 1 }),
    ]) {
      expect(ruleFormProblems(form, confirm).join(' ')).toMatch(/one subject/i)
      expect(isRuleFormValid(form, confirm)).toBe(false)
    }
  })

  it('accepts what one subject satisfies, a disabled block, and a plain rule', () => {
    const form = formFor({ groupingSec: 20 })
    expect(isRuleFormValid(form, withExpect({ op: '>=', count: 1 }))).toBe(true)
    expect(isRuleFormValid(form, withExpect({ op: '<=', count: 1 }))).toBe(true)
    expect(
      isRuleFormValid(form, {
        confirm: { ...CONFIRM_ON, enabled: false, expect: { op: '>=', count: 2 } },
      }),
    ).toBe(true)
    expect(isRuleFormValid(formFor(), withExpect({ op: '>=', count: 2 }))).toBe(true)
    expect(isRuleFormValid(form, undefined)).toBe(true)
  })

  it('a rule that cannot group is not judged (its groupingSec is never sent)', () => {
    const form = formFor({ delivery: 'track-end', groupingSec: 20 })
    expect(isRuleFormValid(form, withExpect({ op: '>=', count: 2 }))).toBe(true)
  })
})
