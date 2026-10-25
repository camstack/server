/**
 * The consumable threshold is the RULE's (D642).
 *
 * The operator: "default 15 % ma configurabile sulla rule" [default 15 % but configurable on the rule]. A rule at 25 must
 * be told about a filter at 20 %; a rule at 10 must not. The hub judges one
 * episode per (threshold, device, item) and stamps the threshold it judged at
 * on the subject; the engine lets a rule hear only the episode judged at ITS
 * threshold — the occupancy rule's per-count keying, one family over.
 */
import type { NcSystemEventCondition, NcSystemEventKind } from '@camstack/types'
import { NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { evaluateRule, NC_SYSTEM_DEVICE_ID, type NcRuleSubject } from '../rule-engine.js'

type SystemEventFilters = Omit<NcSystemEventCondition, 'kinds'>

function ruleWith(kinds: readonly NcSystemEventKind[], filters: SystemEventFilters) {
  const input = NcRuleInputSchema.parse({
    name: 'Consumabili',
    delivery: 'system-event',
    conditions: { systemEvent: { kinds: [...kinds], ...filters } },
    targets: [{ targetId: 'zentik-1' }],
  })
  return NcRuleSchema.parse({ ...input, id: 'r', createdBy: 'admin', createdAt: 1, updatedAt: 1 })
}

/** A subject judged at `judgedAt` — or, with `undefined`, one no band judged. */
function consumableSubject(kind: NcSystemEventKind, judgedAt: number | undefined): NcRuleSubject {
  return {
    kind: 'system-event',
    recordId: 'event-consumable',
    deviceId: NC_SYSTEM_DEVICE_ID,
    timestamp: 1_000,
    classNames: [],
    zones: [],
    systemEvent: {
      kind,
      subject: `consumable@${String(judgedAt ?? 15)}:4385:sensor`,
      deviceId: 4385,
      data: {},
      ...(judgedAt !== undefined ? { consumableLowPercent: judgedAt } : {}),
    },
  }
}

const CONSUMABLE: readonly NcSystemEventKind[] = ['device-consumable-low']

describe('a rule hears only the consumable episode judged at its own threshold', () => {
  it('a rule at 25 hears the episode judged at 25', () => {
    const rule = ruleWith(CONSUMABLE, { consumableLowPercent: 25 })
    expect(evaluateRule(rule, consumableSubject('device-consumable-low', 25)).matched).toBe(true)
  })

  it('a rule at 10 is NOT told about the 25 episode — and the drop is named', () => {
    const rule = ruleWith(CONSUMABLE, { consumableLowPercent: 10 })
    const verdict = evaluateRule(rule, consumableSubject('device-consumable-low', 25))
    expect(verdict.matched).toBe(false)
    expect(verdict.excludedBySystemEventFilter).toBe('consumableLowPercent')
  })

  it('a rule that states no threshold judges at the default, 15', () => {
    const rule = ruleWith(CONSUMABLE, {})
    expect(evaluateRule(rule, consumableSubject('device-consumable-low', 15)).matched).toBe(true)
    expect(evaluateRule(rule, consumableSubject('device-consumable-low', 25)).matched).toBe(false)
  })

  it('the recovery follows the same pairing', () => {
    const rule = ruleWith(['device-consumable-normal'], { consumableLowPercent: 25 })
    expect(evaluateRule(rule, consumableSubject('device-consumable-normal', 25)).matched).toBe(true)
    expect(evaluateRule(rule, consumableSubject('device-consumable-normal', 10)).matched).toBe(
      false,
    )
  })

  it('a subject no band judged (the tester’s synthetic event) is not refused by it', () => {
    const rule = ruleWith(CONSUMABLE, { consumableLowPercent: 25 })
    expect(evaluateRule(rule, consumableSubject('device-consumable-low', undefined)).matched).toBe(
      true,
    )
  })

  it('is IGNORED outside the consumable kinds — a battery on the same rule is untouched', () => {
    const rule = ruleWith(['device-battery-low', 'device-consumable-low'], {
      consumableLowPercent: 25,
    })
    const battery: NcRuleSubject = {
      ...consumableSubject('device-battery-low', 15),
      systemEvent: {
        kind: 'device-battery-low',
        subject: 'battery:3615',
        deviceId: 3615,
        data: {},
        consumableLowPercent: 15,
      },
    }
    expect(evaluateRule(rule, battery).matched).toBe(true)
  })
})
