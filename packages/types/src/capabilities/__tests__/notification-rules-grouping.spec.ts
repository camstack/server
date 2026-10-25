/** D692 §2.1 / §2.3: the grouping field, its bounds and the retired clear keys. */
import { describe, expect, it } from 'vitest'
import {
  NC_CLIP_RETENTION_MAX_SEC,
  NC_GROUPING_DEFAULT_SEC,
  NC_GROUPING_MAX_SEC,
  NC_GROUPING_MIN_SEC,
  isRetiredClearKey,
  NC_RULE_CLEARABLE_KEYS,
  NC_RULE_RETIRED_CLEAR_KEYS,
  NcRuleInputSchema,
  NcRuleSchema,
  NcRuleUpdateInputSchema,
} from '../notification-rules.cap.js'

const base = {
  name: 'r',
  delivery: 'immediate',
  targets: [{ targetId: 't' }],
  conditions: { classes: ['person'] },
} as const

describe('groupingSec (D692 §2.1)', () => {
  it('the constants are the spec values, and the max is the clip-retention cap', () => {
    expect([NC_GROUPING_MIN_SEC, NC_GROUPING_DEFAULT_SEC, NC_GROUPING_MAX_SEC]).toEqual([5, 20, 60])
    expect(NC_GROUPING_MAX_SEC).toBe(NC_CLIP_RETENTION_MAX_SEC)
  })
  it('accepts the bounds and refuses outside them; absent stays absent (no Zod default)', () => {
    expect(NcRuleInputSchema.safeParse({ ...base, groupingSec: 5 }).success).toBe(true)
    expect(NcRuleInputSchema.safeParse({ ...base, groupingSec: 60 }).success).toBe(true)
    expect(NcRuleInputSchema.safeParse({ ...base, groupingSec: 4 }).success).toBe(false)
    expect(NcRuleInputSchema.safeParse({ ...base, groupingSec: 61 }).success).toBe(false)
    expect(NcRuleInputSchema.safeParse({ ...base, groupingSec: 7.5 }).success).toBe(false)
    expect(NcRuleInputSchema.parse(base)).not.toHaveProperty('groupingSec')
  })
  it('groupingSec is clearable, and the two retired keys are still ACCEPTED in clear (§2.3)', () => {
    expect(NC_RULE_CLEARABLE_KEYS).toContain('groupingSec')
    expect(NC_RULE_RETIRED_CLEAR_KEYS).toEqual(['waitForEnhancement', 'groupIdleSec'])
    // The literal tail of the clearable list IS the retired list (spelled out for the
    // viewer-mirror guard, which reads literals) — equality, not mere containment.
    expect(NC_RULE_CLEARABLE_KEYS.slice(-NC_RULE_RETIRED_CLEAR_KEYS.length)).toEqual([
      ...NC_RULE_RETIRED_CLEAR_KEYS,
    ])
    for (const key of NC_RULE_RETIRED_CLEAR_KEYS) {
      expect(NC_RULE_CLEARABLE_KEYS).toContain(key)
      const parsed = NcRuleUpdateInputSchema.safeParse({ ruleId: 'r1', patch: {}, clear: [key] })
      expect(parsed.success).toBe(true)
    }
  })
})

describe('the retired keys are no longer rule fields (D692 §9)', () => {
  it('NcRuleInputSchema and NcRuleSchema do not declare them; Zod strips what a client still sends', () => {
    for (const key of NC_RULE_RETIRED_CLEAR_KEYS) {
      expect(Object.keys(NcRuleInputSchema.shape)).not.toContain(key)
      expect(Object.keys(NcRuleSchema.shape)).not.toContain(key)
    }
    const parsed = NcRuleInputSchema.parse({ ...base, waitForEnhancement: false, groupIdleSec: 30 })
    expect(parsed).not.toHaveProperty('waitForEnhancement')
    expect(parsed).not.toHaveProperty('groupIdleSec')
  })
  it('isRetiredClearKey is true for exactly the retired keys', () => {
    for (const key of NC_RULE_CLEARABLE_KEYS) {
      expect(isRetiredClearKey(key)).toBe(NC_RULE_RETIRED_CLEAR_KEYS.some((r) => r === key))
    }
    expect(isRetiredClearKey('groupingSec')).toBe(false)
    expect(isRetiredClearKey('nope')).toBe(false)
  })
})
