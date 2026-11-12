/**
 * The rule editor's "group notifications within N seconds".
 *
 * A system rule that never set it shows 5 and saves 5. A detection rule shows
 * 0 and saves 0. A number the operator typed survives a trigger change; a
 * number that was only the previous kind's default follows the new kind.
 */
import { NC_CONDITION_CATALOG, type NcRule } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  applyDeliveryChoice,
  buildRuleInput,
  emptyRuleForm,
  ruleFormProblems,
  ruleToForm,
} from '../notification-rules.helpers'

function stored(overrides: Partial<NcRule> = {}): NcRule {
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

describe('groupWithinSec on the rule form', () => {
  it('a new system rule shows 5 and a new detection rule shows 0', () => {
    expect(emptyRuleForm('system-event').groupWithinSec).toBe(5)
    expect(emptyRuleForm('immediate').groupWithinSec).toBe(0)
  })

  it('a stored system rule with no field round-trips as 5', () => {
    const form = ruleToForm(
      stored({
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-offline'] } },
      }),
    )
    expect(form.groupWithinSec).toBe(5)
    expect(buildRuleInput(form, undefined, NC_CONDITION_CATALOG).groupWithinSec).toBe(5)
  })

  it('a stored detection rule with no field round-trips as 0', () => {
    const form = ruleToForm(stored())
    expect(form.groupWithinSec).toBe(0)
    expect(buildRuleInput(form, undefined, NC_CONDITION_CATALOG).groupWithinSec).toBe(0)
  })

  it('keeps a typed window across a trigger change and moves a default', () => {
    const system = emptyRuleForm('system-event')
    const kept = applyDeliveryChoice({ ...system, groupWithinSec: 12 }, 'immediate')
    expect(kept.groupWithinSec).toBe(12)
    const moved = applyDeliveryChoice(system, 'immediate')
    expect(moved.groupWithinSec).toBe(0)
  })

  it('refuses a window past five minutes', () => {
    const form = { ...emptyRuleForm('system-event'), groupWithinSec: 301 }
    expect(ruleFormProblems(form).length).toBeGreaterThan(0)
  })
})
