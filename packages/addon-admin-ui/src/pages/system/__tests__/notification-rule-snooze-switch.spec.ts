/**
 * R3 (D690): the rules list has a Snooze COLUMN with a switch — on while the
 * rule has a live rule-scoped window. Nothing about the alarm in prose.
 */
import type { NcSnooze } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { activeRuleSnoozeIds } from '../NotificationRuleSnoozeSwitch'

function snooze(overrides: Partial<NcSnooze>): NcSnooze {
  return {
    id: 's',
    userId: 'admin',
    scope: 'rule',
    ruleId: 'r1',
    startedAt: 100,
    expiresAt: 200,
    global: false,
    summary: true,
    ...overrides,
  }
}

describe('activeRuleSnoozeIds', () => {
  it('names the live rule-scoped windows of THIS rule', () => {
    const windows = [
      snooze({ id: 'a' }),
      snooze({ id: 'b', ruleId: 'r2' }),
      snooze({ id: 'c', scope: 'device', ruleId: undefined, deviceId: 5 }),
      snooze({ id: 'd', expiresAt: 150 }),
      snooze({ id: 'e', startedAt: 190 }),
    ]
    expect(activeRuleSnoozeIds(windows, 'r1', 160)).toEqual(['a'])
  })

  it('a window is over at exactly its expiry', () => {
    expect(activeRuleSnoozeIds([snooze({ id: 'a' })], 'r1', 200)).toEqual([])
  })
})
