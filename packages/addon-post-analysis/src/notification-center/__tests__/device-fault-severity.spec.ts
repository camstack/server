/**
 * A device fault is announced at EVERY tier. A warning fault reaches the rules
 * as `device-attention-required` carrying its tier; who hears it is the
 * operator's: a rule's `faultSeverities`, and the delivery priority a notifier
 * filters on (a warning is one level below the rule's own priority).
 */
import {
  alertEpisodeEdgeKind,
  alertEpisodePayload,
  alertEpisodeRank,
  DeviceType,
  EventCategory,
  NcRuleInputSchema,
  type Alert,
  type AlertSeverity,
  type SystemEvent,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NcAlertEpisodeLedger, type NcAlertEpisodeEdge } from '../alert-episode-ledger.js'
import type { NcDeviceLookup } from '../device-directory.js'
import { incomingFromSystemEvent } from '../event-intake.js'
import { evaluateRule } from '../rule-engine.js'
import { faultTierPriority, targetDelivery } from '../target-settings.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { makeNcRecords } from './support/nc-test-deps.js'

const NOW = Date.UTC(2026, 10, 22, 12, 0)

const LOOKUP: NcDeviceLookup = (deviceId: number) => ({
  deviceId,
  type: DeviceType.Sensor,
  name: 'Window sensor',
  isCamera: false,
})

function faultAlert(severity: AlertSeverity, status: Alert['status'] = 'active'): Alert {
  const tier = severity === 'warning' ? 'warning' : 'error'
  return {
    id: 'device-error:9',
    category: 'device.error',
    severity,
    title: 'Window sensor: Battery low',
    message: 'Window sensor reports a fault: Battery low.',
    status,
    read: false,
    createdAt: NOW,
    updatedAt: NOW,
    source: { type: 'device', id: '9' },
    metadata: {
      episodeId: 'device-error:9@1',
      faults: [{ code: 'LOW_BAT', label: 'Battery low', severity: tier }],
    },
  }
}

function eventOf(alert: Alert, phase: 'raised' | 'resolved'): SystemEvent {
  return {
    id: 'ev',
    timestamp: new Date(NOW),
    source: { type: 'addon', id: 'alert-center', nodeId: 'hub' },
    category: EventCategory.AlertEpisode,
    data: { ...alertEpisodePayload(alert, phase, NOW) },
  }
}

function subjectOf(alert: Alert, phase: 'raised' | 'resolved') {
  const incoming = incomingFromSystemEvent(eventOf(alert, phase), LOOKUP)
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

function edgeOf(alert: Alert, phase: 'raised' | 'resolved'): NcAlertEpisodeEdge {
  const payload = alertEpisodePayload(alert, phase, NOW)
  return {
    rank: alertEpisodeRank(payload),
    kind: alertEpisodeEdgeKind(payload),
    phase,
    episodeId: payload.episodeId,
    alertId: payload.alertId,
  }
}

const KINDS = ['device-attention-required', 'device-attention-resolved']

describe('a warning fault is a device-attention event', () => {
  it('produces device-attention-required carrying the warning tier', () => {
    const subject = subjectOf(faultAlert('warning'), 'raised')
    expect(subject.systemEvent).toMatchObject({
      kind: 'device-attention-required',
      deviceId: 9,
      faultSeverity: 'warning',
      faultCodes: ['LOW_BAT'],
      textParams: expect.objectContaining({ severity: 'warning' }),
    })
  })

  it('an error fault carries the error tier', () => {
    expect(subjectOf(faultAlert('critical'), 'raised').systemEvent?.faultSeverity).toBe('error')
  })

  it('a rule that names no tier hears the warning', () => {
    const verdict = evaluateRule(
      ruleOf({ kinds: KINDS }),
      subjectOf(faultAlert('warning'), 'raised'),
    )
    expect(verdict.matched).toBe(true)
  })

  it('a rule filtering on severity skips the warning and names the filter', () => {
    const rule = ruleOf({ kinds: KINDS, faultSeverities: ['error'] })
    const verdict = evaluateRule(rule, subjectOf(faultAlert('warning'), 'raised'))
    expect(verdict.matched).toBe(false)
    expect(verdict.excludedBySystemEventFilter).toBe('faultSeverities')
    expect(evaluateRule(rule, subjectOf(faultAlert('critical'), 'raised')).matched).toBe(true)
  })

  it('an empty tier list is every tier', () => {
    const rule = ruleOf({ kinds: KINDS, faultSeverities: [] })
    expect(evaluateRule(rule, subjectOf(faultAlert('warning'), 'raised')).matched).toBe(true)
  })
})

describe('the episode ledger admits a warning fault', () => {
  const ledgerOf = () =>
    new NcAlertEpisodeLedger({
      records: makeNcRecords().records,
      logger: makeSilentLogger(),
    })

  it('notifies the raise once, the escalation once, and the resolution', () => {
    const ledger = ledgerOf()
    expect(ledger.admit(edgeOf(faultAlert('warning'), 'raised'), NOW)).toBe('notify')
    expect(ledger.admit(edgeOf(faultAlert('warning'), 'raised'), NOW)).toBe('duplicate')
    expect(ledger.admit(edgeOf(faultAlert('critical'), 'raised'), NOW)).toBe('notify')
    expect(ledger.admit(edgeOf(faultAlert('warning'), 'raised'), NOW)).toBe('duplicate')
    expect(ledger.admit(edgeOf(faultAlert('warning', 'completed'), 'resolved'), NOW)).toBe('notify')
  })

  it('resolves a fault that never went past its warning', () => {
    const ledger = ledgerOf()
    ledger.admit(edgeOf(faultAlert('warning'), 'raised'), NOW)
    expect(ledger.admit(edgeOf(faultAlert('warning', 'completed'), 'resolved'), NOW)).toBe('notify')
  })
})

describe('the delivery priority follows the tier', () => {
  const rule = { id: 'r', name: 'Faults', priority: 3 }
  const target = { targetId: 't' }

  it('a warning is one level below the rule, an error is the rule', () => {
    expect(targetDelivery(rule, target, 'warning').priority).toBe(2)
    expect(targetDelivery(rule, target, 'error').priority).toBe(3)
    expect(targetDelivery(rule, target).priority).toBe(3)
  })

  it('never goes below the scale', () => {
    expect(faultTierPriority(1, 'warning')).toBe(1)
  })

  it("leaves a target's own priority alone", () => {
    const pinned = { ...rule, targetOverrides: { t: { priority: 5 } } }
    expect(targetDelivery(pinned, target, 'warning').priority).toBe(5)
  })
})
