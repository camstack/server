/**
 * D1022 - a vocabulary command the hub's transition audit settled reaches the
 * Notification Center as the `device-command` kind, named only by its
 * vocabulary action id (D983). A rule narrows it by action id, outcome and
 * actor kind; the hub refuses an id the action index does not know.
 */
import {
  DeviceType,
  EventCategory,
  NcRuleInputSchema,
  NcRuleSchema,
  systemEventFamilyProblems,
  type NcSystemEventCondition,
  type SystemEvent,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcDeviceLookup } from '../device-directory.js'
import { incomingFromSystemEvent } from '../event-intake.js'
import { evaluateRule, type NcRuleSubject } from '../rule-engine.js'

const VELUX: NcDeviceLookup = (deviceId: number) => ({
  deviceId,
  type: DeviceType.Sensor,
  name: 'Velux gateway',
  isCamera: false,
})

const settled = (over: Record<string, unknown> = {}): SystemEvent => ({
  id: 'ev-1',
  timestamp: new Date(1_000),
  source: { type: 'device', id: 5383 },
  category: EventCategory.DeviceCommandSettled,
  data: {
    deviceId: 5383,
    action: 'powerSource.forceRestart',
    outcome: 'confirmed',
    actor: { kind: 'addon', addonId: 'provider-velux' },
    at: 1_000,
    ...over,
  },
})

function subjectOf(event: SystemEvent): NcRuleSubject {
  const incoming = incomingFromSystemEvent(event, VELUX)
  if (incoming === null) throw new Error('no incoming event')
  return incoming.subject
}

function ruleWith(filters: Omit<NcSystemEventCondition, 'kinds'>) {
  const input = NcRuleInputSchema.parse({
    name: 'Restarts',
    delivery: 'system-event',
    conditions: { systemEvent: { kinds: ['device-command'], ...filters } },
    targets: [{ targetId: 'zentik-1' }],
  })
  return NcRuleSchema.parse({ ...input, id: 'r', createdBy: 'admin', createdAt: 1, updatedAt: 1 })
}

describe('D1022 - device-command', () => {
  it('maps a settled command to the kind with the action label and the actor', () => {
    expect(subjectOf(settled()).systemEvent).toMatchObject({
      kind: 'device-command',
      deviceId: 5383,
      commandAction: 'powerSource.forceRestart',
      commandOutcome: 'confirmed',
      commandActorKind: 'addon',
      titleKey: 'system.device-command.title',
      bodyKey: 'system.device-command.body.confirmed',
      textParams: expect.objectContaining({
        deviceName: 'Velux gateway',
        actionLabel: 'Force restart',
        actorLabel: 'provider-velux',
      }),
    })
  })

  it('an action id the index does not know produces nothing', () => {
    expect(incomingFromSystemEvent(settled({ action: 'no.such' }), VELUX)).toBeNull()
  })

  it('a rule on powerSource.forceRestart matches it; another action does not', () => {
    const subject = subjectOf(settled())
    expect(
      evaluateRule(ruleWith({ commandActions: ['powerSource.forceRestart'] }), subject).matched,
    ).toBe(true)
    expect(evaluateRule(ruleWith({ commandActions: ['powerSource.off'] }), subject).matched).toBe(
      false,
    )
  })

  it('outcome and actor-kind filters narrow it', () => {
    const subject = subjectOf(settled())
    expect(evaluateRule(ruleWith({ commandActorKinds: ['addon'] }), subject).matched).toBe(true)
    expect(evaluateRule(ruleWith({ commandActorKinds: ['user'] }), subject).matched).toBe(false)
    expect(evaluateRule(ruleWith({ commandOutcomes: ['failed'] }), subject).matched).toBe(false)
  })

  it('the hub refuses an action id the vocabulary does not know, and accepts a known one', () => {
    const rule = (id: string): NcSystemEventCondition => ({
      kinds: ['device-command'],
      commandActions: [id],
    })
    expect(systemEventFamilyProblems(rule('powerSource.forceRestart'))).toEqual([])
    expect(systemEventFamilyProblems(rule('powerSource.nope'))).toEqual([
      { code: 'unknown-command-action', action: 'powerSource.nope' },
    ])
  })
})
