/**
 * D637, the hub's half: a NEW or UPDATED system-event rule answers ONE family
 * and carries only that family's filters. Stored mixed rules predate this and
 * must stay renamable, toggleable and retargetable (plan ambiguity #3), so the
 * update check judges the MERGED rule and only when the patch touches
 * `delivery` or `conditions`.
 */
import { ncRecordKinds } from '../record-kinds.js'
import { makeNcRecords } from './support/nc-test-deps.js'
import { type NcRuleInput, NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeLogRecorder,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NotificationCenter } from '../index.js'
import { NcRuleStore } from '../rule-store.js'
import {
  assertPatchKeepsFamily,
  assertRuleFamily,
  guardPatchFamily,
  guardRuleFamily,
  NcRuleFamilyRefusal,
} from '../rule-family-guard.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const devices = {
  delivery: 'system-event' as const,
  conditions: { systemEvent: { kinds: ['device-offline' as const] } },
}
const mixedStored = {
  delivery: 'system-event' as const,
  conditions: { systemEvent: { kinds: ['device-offline' as const, 'node-offline' as const] } },
}

describe('assertRuleFamily', () => {
  it('accepts a single-family system rule and ignores every other delivery', () => {
    expect(() => assertRuleFamily(devices)).not.toThrow()
    expect(() => assertRuleFamily({ delivery: 'immediate', conditions: {} })).not.toThrow()
  })
  it('accepts each family with every filter it is allowed', () => {
    expect(() =>
      assertRuleFamily({
        delivery: 'system-event',
        conditions: {
          systemEvent: {
            kinds: ['device-offline', 'device-battery-low'],
            deviceIds: [102],
            excludeDeviceIds: [101],
            deviceTypes: ['camera'],
          },
        },
      }),
    ).not.toThrow()
    expect(() =>
      assertRuleFamily({
        delivery: 'system-event',
        conditions: {
          systemEvent: {
            kinds: ['node-offline', 'addon-updated'],
            nodeIds: ['hub'],
            packageNames: ['x'],
          },
        },
      }),
    ).not.toThrow()
    expect(() =>
      assertRuleFamily({
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['alarm-triggered'], deviceIds: [102] } },
      }),
    ).not.toThrow()
  })
  it('refuses mixed kinds, naming the families', () => {
    expect(() => assertRuleFamily(mixedStored)).toThrow(/device-events \+ system/)
  })
  it('refuses an out-of-family filter, naming it', () => {
    expect(() =>
      assertRuleFamily({
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['node-offline'], deviceIds: [102] } },
      }),
    ).toThrow(/deviceIds.*system/)
  })
  it('refuses a legacy camera-* kind', () => {
    expect(() =>
      assertRuleFamily({
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['camera-offline'] } },
      }),
    ).toThrow(/camera-offline/)
  })
  it('refuses a system rule with no event kind', () => {
    expect(() => assertRuleFamily({ delivery: 'system-event', conditions: {} })).toThrow(
      NcRuleFamilyRefusal,
    )
  })
})

describe('assertPatchKeepsFamily — judged on the MERGED rule', () => {
  it('lets a mixed stored rule be renamed, toggled or retargeted (nothing about its kinds changes)', () => {
    expect(() => assertPatchKeepsFamily(mixedStored, {})).not.toThrow()
  })
  it('lets an UNCHANGED full-form save of a mixed stored rule through (key order irrelevant)', () => {
    const stored = {
      delivery: 'system-event' as const,
      conditions: {
        systemEvent: {
          kinds: ['device-offline' as const, 'node-offline' as const],
          deviceTypes: ['camera'],
        },
      },
    }
    expect(() =>
      assertPatchKeepsFamily(stored, {
        delivery: 'system-event',
        conditions: {
          systemEvent: { deviceTypes: ['camera'], kinds: ['device-offline', 'node-offline'] },
        },
      }),
    ).not.toThrow()
  })
  it('reads kinds and id-list filters as SETS: a reorder of a mixed stored rule is not a change', () => {
    const stored = {
      delivery: 'system-event' as const,
      conditions: {
        systemEvent: {
          kinds: ['device-offline' as const, 'node-offline' as const, 'device-online' as const],
          deviceIds: [102, 104],
          deviceTypes: ['sensor', 'camera'],
          nodeIds: ['mac', 'hub'],
        },
      },
    }
    expect(() =>
      assertPatchKeepsFamily(stored, {
        delivery: 'system-event',
        conditions: {
          systemEvent: {
            kinds: ['device-online', 'device-offline', 'node-offline'],
            deviceIds: [104, 102],
            deviceTypes: ['camera', 'sensor'],
            nodeIds: ['hub', 'mac'],
          },
        },
      }),
    ).not.toThrow()
  })
  it('a reorder plus a real change is still a change, and is judged', () => {
    expect(() =>
      assertPatchKeepsFamily(mixedStored, {
        conditions: {
          systemEvent: { kinds: ['node-offline', 'device-offline'], deviceIds: [102] },
        },
      }),
    ).toThrow(NcRuleFamilyRefusal)
  })
  it('judges a full-form save that changes ONE kind of a mixed stored rule', () => {
    expect(() =>
      assertPatchKeepsFamily(mixedStored, {
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-online', 'node-offline'] } },
      }),
    ).toThrow(/device-events \+ system/)
  })
  it('judges a changed delivery even when the conditions are unchanged', () => {
    expect(() =>
      assertPatchKeepsFamily(
        { delivery: 'immediate', conditions: {} },
        { delivery: 'system-event', conditions: {} },
      ),
    ).toThrow(NcRuleFamilyRefusal)
  })
  it('refuses a conditions patch that mixes families', () => {
    expect(() =>
      assertPatchKeepsFamily(devices, {
        conditions: { systemEvent: { kinds: ['device-offline', 'alarm-armed'] } },
      }),
    ).toThrow(/device-events \+ alarm/)
  })
  it('refuses a delivery patch that turns a camera rule into an empty system rule', () => {
    expect(() =>
      assertPatchKeepsFamily(
        { delivery: 'immediate', conditions: {} },
        { delivery: 'system-event' },
      ),
    ).toThrow(NcRuleFamilyRefusal)
  })
  it('lets a mixed stored rule stop being a system rule (delivery patch away from system-event)', () => {
    expect(() =>
      assertPatchKeepsFamily(mixedStored, { delivery: 'immediate', conditions: {} }),
    ).not.toThrow()
  })
  it('an unknown rule is the store’s to refuse', () => {
    expect(() => assertPatchKeepsFamily(null, { delivery: 'system-event' })).not.toThrow()
  })
})

describe('guardRuleFamily / guardPatchFamily — a refused save is logged, never silent', () => {
  it('logs the offending kinds and filter, then rethrows the refusal', () => {
    const rec = makeLogRecorder()
    const rule = {
      delivery: 'system-event' as const,
      conditions: { systemEvent: { kinds: ['node-offline' as const], deviceIds: [102] } },
    }
    expect(() => guardRuleFamily(rule, { logger: rec.logger, by: 'alice' })).toThrow(
      NcRuleFamilyRefusal,
    )
    const warn = rec.entries.find((e) => e.level === 'warn')
    expect(warn?.message).toMatch(/outside one family/)
    expect(warn?.extras?.meta).toEqual({
      by: 'alice',
      delivery: 'system-event',
      kinds: ['node-offline'],
      problems: ["filter 'deviceIds' is not allowed on a system rule"],
    })
  })
  it('logs the MERGED rule of a refused patch, with its id', () => {
    const rec = makeLogRecorder()
    expect(() =>
      guardPatchFamily(
        devices,
        { conditions: { systemEvent: { kinds: ['device-offline', 'alarm-armed'] } } },
        { logger: rec.logger, by: 'alice', ruleId: 'r9' },
      ),
    ).toThrow(NcRuleFamilyRefusal)
    expect(rec.entries.find((e) => e.level === 'warn')?.extras?.meta).toMatchObject({
      ruleId: 'r9',
      by: 'alice',
      kinds: ['device-offline', 'alarm-armed'],
      problems: ['event kinds span device-events + alarm — one rule per family'],
    })
  })
  it('logs nothing for an accepted rule or a patch that leaves the family alone', () => {
    const rec = makeLogRecorder()
    guardRuleFamily(devices, { logger: rec.logger, by: 'alice' })
    guardPatchFamily(mixedStored, {}, { logger: rec.logger, by: 'alice', ruleId: 'r1' })
    expect(rec.entries).toHaveLength(0)
  })
})

// ── The cap-provider route (`notificationRules.createRule/updateRule`) ──

const centers: NotificationCenter[] = []
afterEach(async () => {
  await Promise.all(centers.splice(0).map((c) => c.stop()))
})

/**
 * `stored` is written straight into the rule collection BEFORE the centre
 * starts, bypassing every save-path guard: that is how a pre-D637 mixed rule
 * exists on a live hub.
 */
async function makeCenter(stored: readonly NcRuleInput[] = []): Promise<NotificationCenter> {
  const world = makeNcRecords()
  const seeder = new NcRuleStore({
    kind: world.records.kind(ncRecordKinds.rules),
    logger: makeSilentLogger(),
  })
  for (const rule of stored) await seeder.create(rule, 'admin')
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: async () => ({
      outboxMs: null,
      timelapseExportMs: null,
      artifactShelfMs: null,
      summaryMosaicMs: null,
    }),
    dispatcher: {
      listTargets: async () => [
        { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'zentik', enabled: true },
      ],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [],
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: false })
  return center
}

const ADMIN = { userId: 'admin', isAdmin: true }

function systemRule(systemEvent: Record<string, unknown>) {
  return NcRuleInputSchema.parse({
    name: 'Eventi di sistema',
    delivery: 'system-event',
    conditions: { systemEvent },
    targets: [{ targetId: 'target-1' }],
  })
}

describe('buildProvider — one family per system rule (D637)', () => {
  it('refuses createRule for kinds that span families', async () => {
    const center = await makeCenter()
    await expect(
      center.buildProvider().createRule({
        caller: ADMIN,
        rule: systemRule({ kinds: ['device-offline', 'node-offline'] }),
      }),
    ).rejects.toThrow(/device-events \+ system/)
    expect((await center.buildProvider().listRules({})).rules).toHaveLength(0)
  })

  it('refuses an updateRule whose conditions mix families', async () => {
    const provider = (await makeCenter()).buildProvider()
    const { rule } = await provider.createRule({
      caller: ADMIN,
      rule: systemRule({ kinds: ['device-offline'], deviceTypes: ['camera'] }),
    })
    await expect(
      provider.updateRule({
        caller: ADMIN,
        ruleId: rule.id,
        patch: { conditions: { systemEvent: { kinds: ['device-offline', 'alarm-armed'] } } },
      }),
    ).rejects.toThrow(/device-events \+ alarm/)
  })

  it('refuses an updateRule that adds an out-of-family filter to a stored rule', async () => {
    const provider = (await makeCenter()).buildProvider()
    const { rule } = await provider.createRule({
      caller: ADMIN,
      rule: systemRule({ kinds: ['node-offline'] }),
    })
    await expect(
      provider.updateRule({
        caller: ADMIN,
        ruleId: rule.id,
        patch: {
          conditions: { systemEvent: { kinds: ['node-offline'], deviceTypes: ['camera'] } },
        },
      }),
    ).rejects.toThrow(/deviceTypes.*system/)
  })

  it('lets a STORED mixed rule be renamed, retargeted and switched off (it keeps firing until recreated)', async () => {
    const center = await makeCenter([systemRule({ kinds: ['device-offline', 'alarm-armed'] })])
    const provider = center.buildProvider()
    const [stored] = (await provider.listRules({})).rules
    if (stored === undefined) throw new Error('seeded rule not loaded')
    const renamed = await provider.updateRule({
      caller: ADMIN,
      ruleId: stored.id,
      patch: { name: 'old', targets: [{ targetId: 'target-1' }], throttle: stored.throttle },
    })
    expect(renamed.rule.name).toBe('old')
    await provider.setRuleEnabled({ ruleId: stored.id, enabled: false })
    expect((await provider.getRule({ ruleId: stored.id })).rule?.enabled).toBe(false)
  })

  it('lets an editor rename a STORED mixed rule with a full-form save (delivery + conditions unchanged)', async () => {
    const seeded = systemRule({ kinds: ['device-offline', 'alarm-armed'], deviceTypes: ['camera'] })
    const provider = (await makeCenter([seeded])).buildProvider()
    const [stored] = (await provider.listRules({})).rules
    if (stored === undefined) throw new Error('seeded rule not loaded')
    const res = await provider.updateRule({
      caller: ADMIN,
      ruleId: stored.id,
      patch: {
        ...seeded,
        name: 'old',
        conditions: {
          systemEvent: { deviceTypes: ['camera'], kinds: ['device-offline', 'alarm-armed'] },
        },
      },
    })
    expect(res.rule.name).toBe('old')
  })

  it('refuses a full-form save that changes one kind of a STORED mixed rule', async () => {
    const seeded = systemRule({ kinds: ['device-offline', 'alarm-armed'] })
    const provider = (await makeCenter([seeded])).buildProvider()
    const [stored] = (await provider.listRules({})).rules
    if (stored === undefined) throw new Error('seeded rule not loaded')
    await expect(
      provider.updateRule({
        caller: ADMIN,
        ruleId: stored.id,
        patch: {
          ...seeded,
          conditions: { systemEvent: { kinds: ['device-online', 'alarm-armed'] } },
        },
      }),
    ).rejects.toThrow(/device-events \+ alarm/)
  })

  it('accepts a no-op full-rule save of a valid single-family rule', async () => {
    const provider = (await makeCenter()).buildProvider()
    const input = systemRule({
      kinds: ['device-offline', 'device-online'],
      deviceTypes: ['camera'],
    })
    const { rule } = await provider.createRule({ caller: ADMIN, rule: input })
    const res = await provider.updateRule({
      caller: ADMIN,
      ruleId: rule.id,
      patch: { ...input, name: 'Eventi di sistema — dispositivi' },
    })
    expect(res.rule.name).toBe('Eventi di sistema — dispositivi')
  })
})
