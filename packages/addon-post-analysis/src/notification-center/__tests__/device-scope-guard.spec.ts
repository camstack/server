/**
 * D641, the hub's half: `devicesExclude` is evaluated wherever `devices` is,
 * and nowhere else. A system rule has its own exclusion
 * (`systemEvent.excludeDeviceIds`, D636); a save that puts this one there is
 * refused and logged, on both save routes.
 */
import { makeNcRecords } from './support/nc-test-deps.js'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeLogRecorder,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  assertDevicesExcludeDelivery,
  guardPatchDevicesExclude,
  guardRuleDevicesExclude,
  NcDevicesExcludeRefusal,
} from '../device-scope-guard.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const detection = {
  delivery: 'immediate' as const,
  conditions: { devicesExclude: [104] },
}
const systemWithExclude = {
  delivery: 'system-event' as const,
  conditions: { devicesExclude: [104], systemEvent: { kinds: ['device-offline' as const] } },
}

describe('assertDevicesExcludeDelivery', () => {
  it('accepts it on every delivery `devices` applies to, and every rule without it', () => {
    for (const delivery of ['immediate', 'track-end', 'device-event', 'package-event'] as const) {
      expect(() =>
        assertDevicesExcludeDelivery({ delivery, conditions: { devicesExclude: [1] } }),
      ).not.toThrow()
    }
    expect(() =>
      assertDevicesExcludeDelivery({ delivery: 'system-event', conditions: {} }),
    ).not.toThrow()
  })

  it('refuses it on a system rule, naming the exclusion that rule does have', () => {
    expect(() => assertDevicesExcludeDelivery(systemWithExclude)).toThrow(
      /devicesExclude.*system-event.*excludeDeviceIds/,
    )
  })
})

describe('guardRuleDevicesExclude / guardPatchDevicesExclude', () => {
  it('logs a refused create and rethrows', () => {
    const rec = makeLogRecorder()
    expect(() =>
      guardRuleDevicesExclude(systemWithExclude, { logger: rec.logger, by: 'alice' }),
    ).toThrow(NcDevicesExcludeRefusal)
    expect(rec.entries.find((e) => e.level === 'warn')?.extras?.meta).toMatchObject({
      by: 'alice',
      delivery: 'system-event',
      devicesExclude: [104],
    })
  })

  it('judges the MERGED rule: moving an excluding rule to system-event is refused', () => {
    const rec = makeLogRecorder()
    expect(() =>
      guardPatchDevicesExclude(
        detection,
        { delivery: 'system-event' },
        { logger: rec.logger, by: 'alice', ruleId: 'r1' },
      ),
    ).toThrow(NcDevicesExcludeRefusal)
    expect(rec.entries.find((e) => e.level === 'warn')?.extras?.meta).toMatchObject({
      ruleId: 'r1',
    })
  })

  it('a patch that changes neither delivery nor conditions is not judged', () => {
    const rec = makeLogRecorder()
    guardPatchDevicesExclude(systemWithExclude, {}, { logger: rec.logger, by: 'x', ruleId: 'r1' })
    guardPatchDevicesExclude(null, { delivery: 'system-event' }, { logger: rec.logger, by: 'x' })
    expect(rec.entries).toHaveLength(0)
  })
})

// ── The cap-provider route (`notificationRules.createRule/updateRule`) ──

const centers: NotificationCenter[] = []
afterEach(async () => {
  await Promise.all(centers.splice(0).map((c) => c.stop()))
})

async function makeCenter(): Promise<NotificationCenter> {
  const world = makeNcRecords()
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

function rule(delivery: string, conditions: Record<string, unknown>) {
  return NcRuleInputSchema.parse({
    name: 'Tutto tranne il garage',
    delivery,
    conditions,
    targets: [{ targetId: 'target-1' }],
  })
}

describe('buildProvider — devicesExclude belongs where devices does (D641)', () => {
  it('creates a detection rule that excludes a camera, and stores the list', async () => {
    const provider = (await makeCenter()).buildProvider()
    const { rule: created } = await provider.createRule({
      caller: ADMIN,
      rule: rule('immediate', { devicesExclude: [104] }),
    })
    expect(created.conditions.devicesExclude).toEqual([104])
  })

  it('refuses a createRule that puts it on a system rule, and stores nothing', async () => {
    const provider = (await makeCenter()).buildProvider()
    await expect(
      provider.createRule({
        caller: ADMIN,
        rule: rule('system-event', {
          systemEvent: { kinds: ['device-offline'] },
          devicesExclude: [104],
        }),
      }),
    ).rejects.toThrow(NcDevicesExcludeRefusal)
    expect((await provider.listRules({})).rules).toHaveLength(0)
  })

  it('refuses an updateRule that adds it to a system rule', async () => {
    const provider = (await makeCenter()).buildProvider()
    const { rule: created } = await provider.createRule({
      caller: ADMIN,
      rule: rule('system-event', { systemEvent: { kinds: ['device-offline'] } }),
    })
    await expect(
      provider.updateRule({
        caller: ADMIN,
        ruleId: created.id,
        patch: {
          conditions: { systemEvent: { kinds: ['device-offline'] }, devicesExclude: [104] },
        },
      }),
    ).rejects.toThrow(NcDevicesExcludeRefusal)
  })
})
