/**
 * A rule on `device-attention-*` can name fault CODES. Empty or absent is any
 * fault; otherwise any fault of the episode in the list matches. A rule with no
 * device filter fires for every device, like the other device kinds.
 */
import {
  alertEpisodePayload,
  DeviceType,
  EventCategory,
  NcRuleInputSchema,
  type Alert,
  type DeviceFault,
  type SystemEvent,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcDeviceLookup } from '../device-directory.js'
import { incomingFromSystemEvent } from '../event-intake.js'
import { evaluateRule } from '../rule-engine.js'

const NOW = Date.UTC(2026, 10, 20, 12, 0)

const LOOKUP: NcDeviceLookup = (deviceId: number) => ({
  deviceId,
  type: DeviceType.Gateway,
  name: 'Casa CCU',
  isCamera: false,
})

const WATCHDOG: DeviceFault = {
  code: 'hb-rf-eth-connection',
  label: 'HB-RF-ETH connection lost',
  severity: 'error',
}
const VOLTAGE: DeviceFault = {
  code: 'low-voltage',
  label: 'CCU supply voltage low',
  severity: 'error',
}

function alertOf(faults: readonly DeviceFault[], deviceId = 9): Alert {
  return {
    id: `device-error:${String(deviceId)}`,
    category: 'device.error',
    severity: 'critical',
    title: 'Casa CCU: fault',
    message: 'fault',
    status: 'active',
    read: false,
    createdAt: NOW,
    updatedAt: NOW,
    source: { type: 'device', id: String(deviceId) },
    metadata: { episodeId: `e${String(deviceId)}@1`, faults },
  }
}

function subjectOf(alert: Alert, phase: 'raised' | 'resolved') {
  const event: SystemEvent = {
    id: 'ev',
    timestamp: new Date(NOW),
    source: { type: 'addon', id: 'alert-center', nodeId: 'hub' },
    category: EventCategory.AlertEpisode,
    data: { ...alertEpisodePayload(alert, phase, NOW) },
  }
  const incoming = incomingFromSystemEvent(event, LOOKUP)
  if (incoming === null || incoming === undefined) throw new Error('no incoming event')
  return incoming.subject
}

function ruleOf(systemEvent: Record<string, unknown>) {
  return NcRuleInputSchema.parse({
    name: 'Faults',
    delivery: 'system-event',
    targets: [{ targetId: 't' }],
    conditions: { systemEvent },
  })
}

const KINDS = ['device-attention-required', 'device-attention-resolved']

describe('faultCodes on a device-attention rule', () => {
  it('matches when a fault of the episode is in the list', () => {
    const rule = ruleOf({ kinds: KINDS, faultCodes: ['hb-rf-eth-connection'] })
    const verdict = evaluateRule(rule, subjectOf(alertOf([WATCHDOG]), 'raised'))
    expect(verdict.matched).toBe(true)
  })

  it('matches on ANY of several faults', () => {
    const rule = ruleOf({ kinds: KINDS, faultCodes: ['low-voltage'] })
    expect(evaluateRule(rule, subjectOf(alertOf([WATCHDOG, VOLTAGE]), 'raised')).matched).toBe(true)
  })

  it('does not match a fault outside the list, and names the filter', () => {
    const rule = ruleOf({ kinds: KINDS, faultCodes: ['low-voltage'] })
    const verdict = evaluateRule(rule, subjectOf(alertOf([WATCHDOG]), 'raised'))
    expect(verdict.matched).toBe(false)
    expect(verdict.excludedBySystemEventFilter).toBe('faultCodes')
  })

  it('an empty or absent list is any fault, a fault outside any catalog included', () => {
    const odd: DeviceFault = { code: 'never-declared', label: 'Odd', severity: 'warning' }
    for (const faultCodes of [undefined, []]) {
      const rule = ruleOf({ kinds: KINDS, ...(faultCodes !== undefined ? { faultCodes } : {}) })
      expect(evaluateRule(rule, subjectOf(alertOf([odd]), 'raised')).matched).toBe(true)
    }
  })

  it('applies to the resolve edge too', () => {
    const rule = ruleOf({ kinds: KINDS, faultCodes: ['low-voltage'] })
    expect(evaluateRule(rule, subjectOf(alertOf([WATCHDOG]), 'resolved')).matched).toBe(false)
    expect(evaluateRule(rule, subjectOf(alertOf([VOLTAGE]), 'resolved')).matched).toBe(true)
  })

  it('with no device filter fires for every device', () => {
    const rule = ruleOf({ kinds: KINDS })
    expect(evaluateRule(rule, subjectOf(alertOf([WATCHDOG], 9), 'raised')).matched).toBe(true)
    expect(evaluateRule(rule, subjectOf(alertOf([VOLTAGE], 31), 'raised')).matched).toBe(true)
  })

  it('exposes {{faultCode}}, {{faultLabel}} and {{faults}} to the template', () => {
    const subject = subjectOf(alertOf([WATCHDOG, VOLTAGE]), 'raised')
    expect(subject.systemEvent?.textParams).toMatchObject({
      faultCode: 'hb-rf-eth-connection',
      faultLabel: 'HB-RF-ETH connection lost',
      faults: 'HB-RF-ETH connection lost, CCU supply voltage low',
    })
  })
})
