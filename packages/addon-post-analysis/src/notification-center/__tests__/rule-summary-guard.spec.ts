/**
 * D647 — the save guard: a scheduled summary on device-events / system rules
 * only; the alarm stays instant. Judged on the MERGED rule on an update.
 */
import { NcRuleInputSchema, scheduleForSendTimes, type NcRuleInput } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  guardPatchSystemEventDelivery,
  guardRuleSystemEventDelivery,
  NcSystemEventDeliveryRefusal,
} from '../rule-summary-guard.js'

const SUMMARY = {
  mode: 'summary' as const,
  schedule: scheduleForSendTimes([{ days: [1, 2, 3, 4, 5], minute: 480 }], 'UTC'),
}

function rule(kinds: readonly string[], extra: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'r',
    delivery: 'system-event',
    conditions: { systemEvent: { kinds } },
    targets: [{ targetId: 't' }],
    ...extra,
  })
}

describe('guardRuleSystemEventDelivery (create, both routes)', () => {
  it('accepts a summary on device-events and system rules, and an absent delivery anywhere', () => {
    const ctx = { logger: makeSilentLogger(), by: 'admin' }
    expect(() =>
      guardRuleSystemEventDelivery(
        rule(['device-battery-low'], { systemEventDelivery: SUMMARY }),
        ctx,
      ),
    ).not.toThrow()
    expect(() =>
      guardRuleSystemEventDelivery(
        rule(['addon-update-available'], { systemEventDelivery: SUMMARY }),
        ctx,
      ),
    ).not.toThrow()
    expect(() => guardRuleSystemEventDelivery(rule(['alarm-triggered']), ctx)).not.toThrow()
  })

  it('refuses a summary on an ALARM rule, loudly', () => {
    const logger = makeSilentLogger()
    const warn = vi.spyOn(logger, 'warn')
    expect(() =>
      guardRuleSystemEventDelivery(rule(['alarm-triggered'], { systemEventDelivery: SUMMARY }), {
        logger,
        by: 'admin',
      }),
    ).toThrow(NcSystemEventDeliveryRefusal)
    expect(warn).toHaveBeenCalledWith(
      'nc rule refused: summary delivery not allowed here',
      expect.objectContaining({ meta: expect.objectContaining({ by: 'admin' }) }),
    )
  })
})

describe('guardPatchSystemEventDelivery (update, both routes)', () => {
  const ctx = { logger: makeSilentLogger(), by: 'admin', ruleId: 'r1' }

  it('refuses switching an alarm rule to summary', () => {
    expect(() =>
      guardPatchSystemEventDelivery(
        rule(['alarm-armed']),
        { systemEventDelivery: SUMMARY },
        [],
        ctx,
      ),
    ).toThrow(NcSystemEventDeliveryRefusal)
  })

  it('refuses a summary beside a stored active-hours schedule — unless the same save clears it', () => {
    const stored = rule(['device-battery-low'], {
      schedule: { windows: [{ days: [1], startMinute: 0, endMinute: 600 }] },
    })
    expect(() =>
      guardPatchSystemEventDelivery(stored, { systemEventDelivery: SUMMARY }, [], ctx),
    ).toThrow(/active-hours schedule/)
    expect(() =>
      guardPatchSystemEventDelivery(stored, { systemEventDelivery: SUMMARY }, ['schedule'], ctx),
    ).not.toThrow()
  })

  it('never refuses a patch that changes nothing the verdict reads', () => {
    const stored = rule(['device-battery-low'], { systemEventDelivery: SUMMARY })
    expect(() => guardPatchSystemEventDelivery(stored, {}, [], ctx)).not.toThrow()
    // Going back to instant is always allowed.
    expect(() =>
      guardPatchSystemEventDelivery(
        rule(['alarm-armed']),
        { systemEventDelivery: { mode: 'instant' } },
        [],
        ctx,
      ),
    ).not.toThrow()
  })
})
