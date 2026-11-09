/**
 * An alarm rule can never be snoozed, and nobody has to remember to say so.
 */

import type { ActionStep, NcRule } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type ActionStepsOf, isSnoozeExempt, type SnoozeExemptRule } from '../snooze-exempt.js'

function rule(over: Partial<Pick<NcRule, 'conditions' | 'actions'>> = {}): SnoozeExemptRule {
  return { conditions: {}, ...over }
}

describe('a rule ABOUT the panel is exempt', () => {
  it('exempts a rule gated on alarm-triggered', () => {
    expect(
      isSnoozeExempt(rule({ conditions: { systemEvent: { kinds: ['alarm-triggered'] } } })),
    ).toBe(true)
  })

  it('exempts alarm-armed and alarm-disarmed too — the whole lifecycle', () => {
    expect(isSnoozeExempt(rule({ conditions: { systemEvent: { kinds: ['alarm-armed'] } } }))).toBe(
      true,
    )
    expect(
      isSnoozeExempt(rule({ conditions: { systemEvent: { kinds: ['alarm-disarmed'] } } })),
    ).toBe(true)
  })

  it('does NOT exempt an ordinary system rule', () => {
    expect(
      isSnoozeExempt(rule({ conditions: { systemEvent: { kinds: ['device-offline'] } } })),
    ).toBe(false)
  })
})

const PANEL_STEP: ActionStep = {
  kind: 'cap',
  target: { kind: 'devices', ids: [900] },
  cap: 'alarm-panel',
  method: 'trigger',
}
const SWITCH_STEP: ActionStep = {
  kind: 'cap',
  target: { kind: 'devices', ids: [12] },
  cap: 'switch',
  method: 'turnOn',
}

/** The centre's mirror of the Actions list, as the gate reads it. */
const STEPS_OF: ActionStepsOf = (id) =>
  id === 'internal:panel' ? [PANEL_STEP] : id === 'internal:switch' ? [SWITCH_STEP] : undefined

describe('a rule that RUNS an Action actuating the panel is exempt', () => {
  it('exempts a hook that runs an Action calling alarm-panel', () => {
    expect(
      isSnoozeExempt(rule({ actions: { onTrigger: ['internal:panel'] } }), STEPS_OF),
    ).toBe(true)
  })

  it('exempts a BUTTON-ONLY Action via the resolver', () => {
    expect(
      isSnoozeExempt(
        rule({ actions: { buttons: [{ id: 'arm', label: 'Arma', actionId: 'internal:panel' }] } }),
        STEPS_OF,
      ),
    ).toBe(true)
  })

  it('does NOT exempt a rule whose Action actuates something else', () => {
    expect(
      isSnoozeExempt(rule({ actions: { onTrigger: ['internal:switch'] } }), STEPS_OF),
    ).toBe(false)
  })

  it('an Action the mirror has never seen cannot prove the exemption', () => {
    expect(isSnoozeExempt(rule({ actions: { onTrigger: ['internal:unknown'] } }), STEPS_OF)).toBe(
      false,
    )
    expect(isSnoozeExempt(rule({ actions: { onTrigger: ['internal:panel'] } }))).toBe(false)
  })
})

describe('the plain case', () => {
  it('an ordinary detection rule is snoozeable', () => {
    expect(isSnoozeExempt(rule({ conditions: { classes: ['person'] } }))).toBe(false)
  })

  it('a rule with no conditions and no actions is snoozeable', () => {
    expect(isSnoozeExempt(rule())).toBe(false)
  })
})
