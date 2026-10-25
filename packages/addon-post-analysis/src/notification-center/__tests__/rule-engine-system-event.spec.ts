import { NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  cooldownKey,
  evaluateRule,
  NC_SYSTEM_DEVICE_ID,
  type NcRuleSubject,
} from '../rule-engine.js'

function rule(systemEvent: Record<string, unknown>) {
  const input = NcRuleInputSchema.parse({
    name: 'system rule',
    delivery: 'system-event',
    conditions: { systemEvent },
    targets: [{ targetId: 'target-1' }],
  })
  return NcRuleSchema.parse({
    ...input,
    id: 'rule-1',
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 1,
  })
}

function subject(
  overrides: Partial<NonNullable<NcRuleSubject['systemEvent']>> = {},
): NcRuleSubject {
  return {
    kind: 'system-event',
    recordId: 'event-1',
    deviceId: NC_SYSTEM_DEVICE_ID,
    timestamp: 100,
    classNames: [],
    zones: [],
    systemEvent: {
      kind: 'node-offline',
      subject: 'node:agent-a',
      title: 'Node offline',
      body: 'Agent agent-a is offline',
      nodeId: 'agent-a',
      data: {},
      ...overrides,
    },
  }
}

function subjectWithoutIdentities(
  kind: NonNullable<NcRuleSubject['systemEvent']>['kind'],
): NcRuleSubject {
  return {
    kind: 'system-event',
    recordId: 'event-no-identity',
    deviceId: NC_SYSTEM_DEVICE_ID,
    timestamp: 100,
    classNames: [],
    zones: [],
    systemEvent: {
      kind,
      subject: `system:${kind}`,
      title: 'System event',
      body: 'System event',
      data: {},
    },
  }
}

describe('system-event rule matching', () => {
  it('matches kind plus the relevant optional filter', () => {
    const result = evaluateRule(rule({ kinds: ['node-offline'], nodeIds: ['agent-a'] }), subject())
    expect(result).toMatchObject({ matched: true, matchedOn: ['systemEvent'] })
  })

  it('fails on kind, node, device, or package mismatches', () => {
    expect(evaluateRule(rule({ kinds: ['node-online'] }), subject()).matched).toBe(false)
    expect(
      evaluateRule(rule({ kinds: ['node-offline'], nodeIds: ['agent-b'] }), subject()).matched,
    ).toBe(false)
    expect(
      evaluateRule(
        rule({ kinds: ['device-offline'], deviceIds: [102] }),
        subject({ kind: 'device-offline', deviceId: 104 }),
      ).matched,
    ).toBe(false)
    expect(
      evaluateRule(
        rule({
          kinds: ['addon-update-available'],
          packageNames: ['@camstack/addon-recorder'],
        }),
        subject({
          kind: 'addon-update-available',
          packageName: '@camstack/addon-pipeline',
        }),
      ).matched,
    ).toBe(false)
  })

  it('fails closed when an IN-FAMILY filter has no corresponding subject identity', () => {
    // A device rule that names device ids, against a device event carrying
    // none: the filter is about this kind and cannot be satisfied, so it
    // excludes. Same for a node rule that names nodes, and an update rule that
    // names packages.
    expect(
      evaluateRule(
        rule({ kinds: ['device-offline'], deviceIds: [104] }),
        subjectWithoutIdentities('device-offline'),
      ).matched,
    ).toBe(false)
    expect(
      evaluateRule(
        rule({ kinds: ['node-offline'], nodeIds: ['agent-a'] }),
        subjectWithoutIdentities('node-offline'),
      ).matched,
    ).toBe(false)
    expect(
      evaluateRule(
        rule({ kinds: ['addon-update-available'], packageNames: ['@camstack/addon-pipeline'] }),
        subjectWithoutIdentities('addon-update-available'),
      ).matched,
    ).toBe(false)
  })

  /**
   * The inverse, and the reason this file changed: a filter is SCOPED to the
   * kinds it is about. It used to be applied to every kind, so a `deviceIds`
   * on a node rule — or the operator's `deviceTypes: ['camera']` on an
   * eleven-kind rule — closed the kinds it was never about. Pinned in full in
   * `system-event-filter-scope.spec.ts`; the three shapes that used to be
   * asserted here as fail-closed are kept as their opposite so this file
   * cannot quietly regain the old contract.
   */
  it('IGNORES an out-of-family filter instead of failing closed', () => {
    expect(
      evaluateRule(rule({ kinds: ['node-offline'], deviceIds: [104] }), subject()).matched,
    ).toBe(true)
    expect(
      evaluateRule(rule({ kinds: ['device-offline'], nodeIds: ['agent-a'] }), {
        ...subjectWithoutIdentities('device-offline'),
        systemEvent: {
          ...subjectWithoutIdentities('device-offline').systemEvent!,
          deviceId: 104,
        },
      }).matched,
    ).toBe(true)
    expect(
      evaluateRule(
        rule({ kinds: ['node-offline'], packageNames: ['@camstack/addon-pipeline'] }),
        subjectWithoutIdentities('node-offline'),
      ).matched,
    ).toBe(true)
  })

  it('does not let a system rule match a non-system subject', () => {
    const nonSystem: NcRuleSubject = {
      kind: 'object-event',
      recordId: 'object-1',
      deviceId: 104,
      timestamp: 100,
      classNames: ['person'],
      zones: [],
    }
    expect(evaluateRule(rule({ kinds: ['device-offline'] }), nonSystem)).toMatchObject({
      matched: false,
      failedCondition: 'delivery',
    })
  })

  it('scopes the default cooldown by normalized system subject AND direction', () => {
    // The `:k:` tail is the fix for the 2026-08-13 duplicate: a cooldown is a
    // budget for volume and must never swallow the opposite edge. See
    // `system-event-cooldown-direction.spec.ts`.
    expect(cooldownKey(rule({ kinds: ['node-offline'] }), subject())).toBe(
      'r:rule-1:s:node:agent-a:k:node-offline',
    )
    expect(cooldownKey(rule({ kinds: ['node-online'] }), subject({ kind: 'node-online' }))).toBe(
      'r:rule-1:s:node:agent-a:k:node-online',
    )
  })

  it('keeps addon update cooldowns distinct across hub and agent nodes', () => {
    const updateRule = rule({ kinds: ['addon-update-available'] })
    const hub: NcRuleSubject = {
      ...subjectWithoutIdentities('addon-update-available'),
      systemEvent: {
        ...subjectWithoutIdentities('addon-update-available').systemEvent!,
        subject: 'package:hub:@camstack/addon-pipeline',
        packageName: '@camstack/addon-pipeline',
      },
    }
    const agent = subject({
      kind: 'addon-update-available',
      subject: 'package:agent-a:@camstack/addon-pipeline',
      nodeId: 'agent-a',
      packageName: '@camstack/addon-pipeline',
    })
    expect(cooldownKey(updateRule, hub)).not.toBe(cooldownKey(updateRule, agent))
  })
})
