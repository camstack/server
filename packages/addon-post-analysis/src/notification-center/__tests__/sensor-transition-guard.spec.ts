/**
 * D640, the hub's half: `sensorTransition` means something only on a
 * device-event rule (it reads the raise of a boolean sensor). A save that puts
 * it on any other delivery is refused and logged, on both save routes.
 */
import { makeNcRecords } from './support/nc-test-deps.js'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeLogRecorder,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NotificationCenter } from '../index.js'
import {
  assertSensorTransitionDelivery,
  guardPatchSensorTransition,
  guardRuleSensorTransition,
  NcSensorTransitionRefusal,
} from '../sensor-transition-guard.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const sensorRule = {
  delivery: 'device-event' as const,
  conditions: { sensorKinds: ['flood'], sensorTransition: 'raised' as const },
}
const detectionWithTransition = {
  delivery: 'immediate' as const,
  conditions: { classes: ['person'], sensorTransition: 'raised' as const },
}

describe('assertSensorTransitionDelivery', () => {
  it('accepts it on a device-event rule, and every rule that does not carry it', () => {
    expect(() => assertSensorTransitionDelivery(sensorRule)).not.toThrow()
    expect(() =>
      assertSensorTransitionDelivery({ delivery: 'immediate', conditions: {} }),
    ).not.toThrow()
  })

  it('refuses it on every other delivery, naming the delivery', () => {
    for (const delivery of ['immediate', 'track-end', 'package-event', 'system-event'] as const) {
      expect(() =>
        assertSensorTransitionDelivery({ delivery, conditions: { sensorTransition: 'cleared' } }),
      ).toThrow(new RegExp(`sensorTransition.*${delivery}`))
    }
  })
})

describe('guardRuleSensorTransition / guardPatchSensorTransition', () => {
  it('logs a refused create and rethrows', () => {
    const rec = makeLogRecorder()
    expect(() =>
      guardRuleSensorTransition(detectionWithTransition, { logger: rec.logger, by: 'alice' }),
    ).toThrow(NcSensorTransitionRefusal)
    const warn = rec.entries.find((e) => e.level === 'warn')
    expect(warn?.extras?.meta).toMatchObject({
      by: 'alice',
      delivery: 'immediate',
      sensorTransition: 'raised',
    })
  })

  it('judges the MERGED rule: moving a sensor rule off device-event is refused', () => {
    const rec = makeLogRecorder()
    expect(() =>
      guardPatchSensorTransition(
        sensorRule,
        { delivery: 'immediate' },
        { logger: rec.logger, by: 'alice', ruleId: 'r1' },
      ),
    ).toThrow(NcSensorTransitionRefusal)
    expect(rec.entries.find((e) => e.level === 'warn')?.extras?.meta).toMatchObject({
      ruleId: 'r1',
    })
  })

  it('a patch that changes neither delivery nor conditions is not judged', () => {
    const rec = makeLogRecorder()
    guardPatchSensorTransition(
      detectionWithTransition,
      {},
      {
        logger: rec.logger,
        by: 'alice',
        ruleId: 'r1',
      },
    )
    guardPatchSensorTransition(null, { delivery: 'immediate' }, { logger: rec.logger, by: 'x' })
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
    name: 'Allagamento',
    delivery,
    conditions,
    targets: [{ targetId: 'target-1' }],
  })
}

describe('buildProvider — sensorTransition belongs to device-event (D640)', () => {
  it('creates a device-event rule that carries it', async () => {
    const provider = (await makeCenter()).buildProvider()
    const { rule: created } = await provider.createRule({
      caller: ADMIN,
      rule: rule('device-event', { sensorKinds: ['flood'], sensorTransition: 'raised' }),
    })
    expect(created.conditions.sensorTransition).toBe('raised')
  })

  it('refuses a createRule that puts it on another delivery, and stores nothing', async () => {
    const provider = (await makeCenter()).buildProvider()
    await expect(
      provider.createRule({
        caller: ADMIN,
        rule: rule('immediate', { classes: ['person'], sensorTransition: 'raised' }),
      }),
    ).rejects.toThrow(NcSensorTransitionRefusal)
    expect((await provider.listRules({})).rules).toHaveLength(0)
  })

  it('refuses an updateRule that moves the rule off device-event', async () => {
    const provider = (await makeCenter()).buildProvider()
    const { rule: created } = await provider.createRule({
      caller: ADMIN,
      rule: rule('device-event', { sensorKinds: ['flood'], sensorTransition: 'raised' }),
    })
    await expect(
      provider.updateRule({ caller: ADMIN, ruleId: created.id, patch: { delivery: 'immediate' } }),
    ).rejects.toThrow(NcSensorTransitionRefusal)
  })
})
