/**
 * `excludeDeviceIds` — "every battery except THAT one".
 *
 * The live case: a thermometer (3615) whose battery reads 0 % forever and is at
 * reminder r45. The operator wants every other battery and consumable alert,
 * and an include list would have to name every other battery device — and
 * silently leave out every device adopted later. So the rule carries an
 * EXCLUDE list, applied after the include list, in the same kind family as
 * `deviceIds` (D636).
 */
import type { NcSystemEventCondition, NcSystemEventKind } from '@camstack/types'
import { NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { evaluateRule, NC_SYSTEM_DEVICE_ID, type NcRuleSubject } from '../rule-engine.js'

type SystemEventFilters = Omit<NcSystemEventCondition, 'kinds'>

function ruleWith(kinds: readonly NcSystemEventKind[], filters: SystemEventFilters) {
  const input = NcRuleInputSchema.parse({
    name: 'Batterie e consumabili',
    delivery: 'system-event',
    conditions: { systemEvent: { kinds: [...kinds], ...filters } },
    targets: [{ targetId: 'zentik-1' }],
  })
  return NcRuleSchema.parse({ ...input, id: 'r', createdBy: 'admin', createdAt: 1, updatedAt: 1 })
}

function subjectOf(
  kind: NcSystemEventKind,
  subject: string,
  deviceId: number | undefined,
): NcRuleSubject {
  return {
    kind: 'system-event',
    recordId: `event-${subject}`,
    deviceId: NC_SYSTEM_DEVICE_ID,
    timestamp: 1_000,
    classNames: [],
    zones: [],
    systemEvent: {
      kind,
      subject,
      data: {},
      ...(deviceId !== undefined ? { deviceId } : {}),
    },
  }
}

const BATTERY_KINDS: readonly NcSystemEventKind[] = ['device-battery-low', 'device-consumable-low']

describe('system-event excludeDeviceIds', () => {
  it('a battery subject whose device is excluded never matches, and the filter is NAMED', () => {
    const rule = ruleWith(BATTERY_KINDS, { excludeDeviceIds: [3615] })
    const verdict = evaluateRule(rule, subjectOf('device-battery-low', 'battery:3615', 3615))
    expect(verdict.matched).toBe(false)
    expect(verdict.excludedBySystemEventFilter).toBe('excludeDeviceIds')
  })

  it('every other device still matches', () => {
    const rule = ruleWith(BATTERY_KINDS, { excludeDeviceIds: [3615] })
    expect(evaluateRule(rule, subjectOf('device-battery-low', 'battery:3602', 3602)).matched).toBe(
      true,
    )
  })

  it('a consumable subject is excluded by its DEVICE id, whatever the item', () => {
    const rule = ruleWith(BATTERY_KINDS, { excludeDeviceIds: [4385] })
    for (const item of ['sensor', 'wheel']) {
      const verdict = evaluateRule(
        rule,
        subjectOf('device-consumable-low', `consumable@15:4385:${item}`, 4385),
      )
      expect(verdict.matched).toBe(false)
      expect(verdict.excludedBySystemEventFilter).toBe('excludeDeviceIds')
    }
  })

  it('include first, then exclude: an id in BOTH lists does not match', () => {
    const rule = ruleWith(BATTERY_KINDS, { deviceIds: [3602, 3615], excludeDeviceIds: [3615] })
    expect(evaluateRule(rule, subjectOf('device-battery-low', 'battery:3602', 3602)).matched).toBe(
      true,
    )
    const both = evaluateRule(rule, subjectOf('device-battery-low', 'battery:3615', 3615))
    expect(both.matched).toBe(false)
    expect(both.excludedBySystemEventFilter).toBe('excludeDeviceIds')
    // Outside the include list the INCLUDE list is what refuses it.
    const outside = evaluateRule(rule, subjectOf('device-battery-low', 'battery:9', 9))
    expect(outside.excludedBySystemEventFilter).toBe('deviceIds')
  })

  it('never fails closed: a subject with no device id is not excluded', () => {
    const rule = ruleWith(['device-offline'], { excludeDeviceIds: [3615] })
    expect(evaluateRule(rule, subjectOf('device-offline', 'device:?', undefined)).matched).toBe(
      true,
    )
  })

  it('is IGNORED outside the device family — a node event carries no device to exclude', () => {
    const rule = ruleWith(['node-offline', 'device-battery-low'], { excludeDeviceIds: [3615] })
    const node = subjectOf('node-offline', 'node:agent-a', 3615)
    expect(evaluateRule(rule, node).matched).toBe(true)
  })
})
