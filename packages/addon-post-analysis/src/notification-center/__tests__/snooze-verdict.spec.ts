/**
 * The ONE snooze decision (D692 C4): the send gate and the grouped close both ask
 * `snoozeVerdict`, so it must answer exactly what the gate always answered — no window, a
 * covering window, or a covering window an alarm rule is exempt from (D697).
 */

import type { NcSnooze } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { SnoozeExemptRule } from '../snooze-exempt.js'
import { activeSnoozeFor } from '../snooze-policy.js'
import { snoozeVerdict } from '../snooze-verdict.js'

const WINDOW: NcSnooze = {
  id: 'sn-1',
  userId: 'u-1',
  scope: 'device',
  deviceId: 104,
  classes: ['dog'],
  startedAt: 0,
  expiresAt: 60_000,
  global: false,
  summary: true,
}

const PLAIN: SnoozeExemptRule = { conditions: { classes: ['dog'] }, actions: {} }
const ALARM: SnoozeExemptRule = {
  conditions: { classes: ['dog'] },
  actions: {
    onTrigger: [
      {
        kind: 'do',
        action: { kind: 'cap', deviceId: 7, cap: 'alarm-panel', method: 'trigger' },
      },
    ],
  },
}

function ask(className: string, ownerUserId: string | undefined, rule: SnoozeExemptRule | null) {
  return snoozeVerdict(
    {
      ruleId: 'r1',
      ruleName: 'r',
      targetId: 'tgt-1',
      deviceId: 104,
      ...(ownerUserId !== undefined ? { ownerUserId } : {}),
      className,
      at: 1_000,
    },
    { activeFor: (q) => activeSnoozeFor([WINDOW], q), ruleFor: () => rule },
  )
}

describe('snoozeVerdict (D692 C4)', () => {
  it('suppressed for the owner it covers, on the class it names', () => {
    expect(ask('dog', 'u-1', PLAIN)).toEqual({ kind: 'suppressed', snooze: WINDOW })
  })

  it('clear for another class, another owner, or an unowned target', () => {
    expect(ask('person', 'u-1', PLAIN)).toEqual({ kind: 'clear' })
    expect(ask('dog', 'u-2', PLAIN)).toEqual({ kind: 'clear' })
    expect(ask('dog', undefined, PLAIN)).toEqual({ kind: 'clear' })
  })

  it('exempt for an alarm rule (D697), suppressed for a rule that is gone', () => {
    expect(ask('dog', 'u-1', ALARM)).toEqual({ kind: 'exempt', snooze: WINDOW })
    expect(ask('dog', 'u-1', null)).toEqual({ kind: 'suppressed', snooze: WINDOW })
  })
})
