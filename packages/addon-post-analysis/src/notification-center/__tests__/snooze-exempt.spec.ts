/**
 * An alarm rule can never be snoozed, and nobody has to remember to say so.
 */

import type { NcRule } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { isSnoozeExempt, type SnoozeExemptRule } from '../snooze-exempt.js'

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

describe('a rule that ACTUATES the panel is exempt', () => {
  it('exempts a Do binding that calls alarm-panel', () => {
    expect(
      isSnoozeExempt(
        rule({
          actions: {
            onTrigger: [
              {
                kind: 'do',
                action: { kind: 'cap', deviceId: 900, cap: 'alarm-panel', method: 'trigger' },
              },
            ],
          },
        }),
      ),
    ).toBe(true)
  })

  it('exempts a BUTTON-ONLY sequence via the resolver', () => {
    expect(
      isSnoozeExempt(
        rule({
          actions: {
            buttons: [{ id: 'arm', label: 'Arma', sequenceId: 's-arm' }],
          },
        }),
        (id) =>
          id === 's-arm'
            ? [{ kind: 'cap', deviceId: 900, cap: 'alarm-panel', method: 'arm' }]
            : undefined,
      ),
    ).toBe(true)
  })

  it('does NOT exempt a rule that actuates something else', () => {
    expect(
      isSnoozeExempt(
        rule({
          actions: {
            onTrigger: [
              {
                kind: 'do',
                action: { kind: 'cap', deviceId: 12, cap: 'switch', method: 'turnOn' },
              },
            ],
          },
        }),
      ),
    ).toBe(false)
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
