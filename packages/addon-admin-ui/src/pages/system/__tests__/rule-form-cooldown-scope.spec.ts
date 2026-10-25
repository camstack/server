/**
 * The cooldown's SCOPE and class GRANULARITY are authored by the admin editor
 * (D654), not merely preserved.
 *
 * `NcThrottleSchema` has carried `scope` (`rule` | `rule-device`) and
 * `granularity` (`shared` | `per-class`) for months, but the editor authored
 * only `cooldownSec`: the other two could be set from the viewer or the API
 * and were invisible here. A knob the operator cannot see is one they cannot
 * reason about — "why did the dog not notify?" is answered by the granularity.
 *
 * Round trip is the contract: load → form → save keeps every key, and an unset
 * granularity is not written — writing an explicit value onto every rule
 * saved here would make it look authored. Since 2026-10-01 (D36's dated note)
 * absent reads as `per-class` on the ENGINE, not `shared`; the admin SELECT
 * offers exactly the two schema values (no third "unset" entry — the previous
 * `''` and `'shared'` meant the same thing) and shows `per-class` for an
 * untouched field without writing it.
 */
import type { NcRule } from '@camstack/types'
import { NC_CONDITION_CATALOG } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildRuleInput,
  emptyRuleForm,
  NC_COOLDOWN_GRANULARITY_OPTIONS,
  NC_COOLDOWN_SCOPE_OPTIONS,
  NC_RULE_TABS,
  parseCooldownGranularity,
  parseCooldownScope,
  ruleToForm,
} from '../notification-rules.helpers'

function rule(throttle: NcRule['throttle']): NcRule {
  return {
    id: 'r1',
    name: 'Front door',
    enabled: true,
    disabledTargetIds: [],
    delivery: 'immediate',
    conditions: { classes: ['person', 'dog'] },
    targets: [{ targetId: 't1' }],
    media: { attach: 'best' },
    throttle,
    priority: 3,
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 1,
  }
}

/** Save with NO preserved fields: whatever survives came from the FORM. */
function saved(r: NcRule): NcRule['throttle'] {
  return buildRuleInput(ruleToForm(r), undefined, NC_CONDITION_CATALOG).throttle
}

describe('cooldown scope + granularity — round trip', () => {
  it('keeps every throttle key through load → form → save', () => {
    for (const throttle of [
      { cooldownSec: 120, scope: 'rule', granularity: 'per-class' },
      { cooldownSec: 30, scope: 'rule-device', granularity: 'shared' },
      { cooldownSec: 0, scope: 'rule' },
      { cooldownSec: 60, scope: 'rule-device' },
    ] as const) {
      expect(saved(rule(throttle))).toEqual(throttle)
    }
  })

  it('does not WRITE a granularity the rule never had', () => {
    const out = saved(rule({ cooldownSec: 60, scope: 'rule-device' }))
    expect('granularity' in out).toBe(false)
  })

  it('writes what the operator changed', () => {
    const form = {
      ...ruleToForm(rule({ cooldownSec: 60, scope: 'rule-device' })),
      cooldownScope: 'rule' as const,
      cooldownGranularity: 'per-class' as const,
    }
    expect(buildRuleInput(form, undefined, NC_CONDITION_CATALOG).throttle).toEqual({
      cooldownSec: 60,
      scope: 'rule',
      granularity: 'per-class',
    })
  })

  it('clearing the granularity back to the default REMOVES the key', () => {
    const form = {
      ...ruleToForm(rule({ cooldownSec: 60, scope: 'rule', granularity: 'per-class' })),
      cooldownGranularity: undefined,
    }
    const out = buildRuleInput(form, undefined, NC_CONDITION_CATALOG).throttle
    expect(out).toEqual({ cooldownSec: 60, scope: 'rule' })
  })

  it('a new rule starts per camera, unset granularity — which the engine reads as per-class', () => {
    const form = emptyRuleForm()
    expect(form.cooldownScope).toBe('rule-device')
    expect(form.cooldownGranularity).toBeUndefined()
  })

  it('both fields are claimed by the Advanced tab, beside the cooldown', () => {
    const advanced = NC_RULE_TABS.find((t) => t.key === 'advanced')
    expect(advanced?.fields).toEqual(
      expect.arrayContaining(['cooldownSec', 'cooldownScope', 'cooldownGranularity']),
    )
  })
})

describe('cooldown scope + granularity — parsing matches the schema', () => {
  it('scope: exactly the two values NcThrottleSchema takes', () => {
    expect(NC_COOLDOWN_SCOPE_OPTIONS.map((o) => o.value)).toEqual(['rule-device', 'rule'])
    expect(parseCooldownScope('rule')).toBe('rule')
    expect(parseCooldownScope('rule-device')).toBe('rule-device')
    expect(parseCooldownScope('device')).toBeUndefined()
    expect(parseCooldownScope('')).toBeUndefined()
  })

  it('granularity: exactly the two schema values, per-class first (the default), nothing else', () => {
    expect(NC_COOLDOWN_GRANULARITY_OPTIONS.map((o) => o.value)).toEqual(['per-class', 'shared'])
    expect(parseCooldownGranularity('')).toBeUndefined()
    expect(parseCooldownGranularity('shared')).toBe('shared')
    expect(parseCooldownGranularity('per-class')).toBe('per-class')
    expect(parseCooldownGranularity('per-zone')).toBeUndefined()
  })
})
