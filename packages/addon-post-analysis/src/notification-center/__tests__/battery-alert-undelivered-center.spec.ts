/**
 * The live 2026-09-25 case, end to end through the real centre: a battery at
 * 0 % on a SENSOR, and the only system rule narrowed to cameras. The raise
 * matches no rule, so nothing is enqueued — and the episode must stay PENDING,
 * so that the moment the operator fixes the rule, the next reload tick
 * delivers it. Before D636 the row was stamped "notified" and the fixed rule
 * heard of it only at the next reminder (≤ 12 h; never with reminders off).
 *
 * This drives the production `emit` (the reporting door) and the production
 * rules fingerprint — the unit spec fakes both.
 */
import { DeviceType, NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcTargetRef } from '../dispatcher.js'
import { ncPruneWindowsPort, makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

describe('an undelivered battery raise is delivered once the rule is fixed', () => {
  const centers: NotificationCenter[] = []

  afterEach(async () => {
    await Promise.all(centers.map((center) => center.stop()))
  })

  it('a raise refused only by the rule SCHEDULE is delivered once the window opens (review C1)', async () => {
    const world = makeNcRecords()
    const targets: NcTargetRef[] = [
      { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
    ]
    // 2026-09-25 03:00 UTC — outside a 08:00–22:00 UTC window.
    let clock = Date.UTC(2026, 8, 25, 3, 0)
    const center = new NotificationCenter({
      deviceSettings: makeFakeDeviceSettings(),
      records: world.records,
      logger: makeSilentLogger(),
      pruneWindows: ncPruneWindowsPort(),
      now: () => clock,
      dispatcher: {
        listTargets: async () => targets,
        send: async () => ({ success: true }),
        getMediaForOwner: async () => [],
        getDeviceName: async () => 'Termometro sala server',
      },
      listObjectEventsSince: async () => [],
      listRecentTracks: async () => [],
      listDeviceIdentities: async () => [
        { deviceId: 3615, type: DeviceType.Sensor, name: 'Termometro', isCamera: false },
      ],
      drainIntervalMs: 3_600_000,
      ruleReloadIntervalMs: 40,
      readDeviceAlertSettings: () => ({
        batteryLowPercent: 20,
        renotifyMinutes: 60,
        notifyRecovery: true,
      }),
    })
    centers.push(center)
    await center.start({ evaluation: true })
    await center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Batterie e consumabili',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-battery-low'] } },
        schedule: {
          windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 8 * 60, endMinute: 22 * 60 }],
          timezone: 'UTC',
        },
        targets: [{ targetId: 'target-1' }],
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })
    center.onSystemEvent({
      id: 'battery-slice',
      timestamp: new Date(clock),
      source: { type: 'device', id: 3615 },
      category: 'device.state-changed',
      data: { deviceId: 3615, capName: 'battery', slice: { percentage: 0, lastUpdated: 5_000 } },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    expect(ncTable(world, 'outbox')?.size ?? 0).toBe(0)

    // 09:00 — the window is open, and nobody edited a rule.
    clock = Date.UTC(2026, 8, 25, 9, 0)
    await vi.waitFor(
      () => {
        expect(ncTable(world, 'outbox')?.size).toBe(1)
      },
      { timeout: 2_000 },
    )
    // Several more ticks: still exactly one.
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    expect(ncTable(world, 'outbox')?.size).toBe(1)
  })

  it('camera-only rule refuses it; the same rule without deviceTypes delivers it on the next tick', async () => {
    const world = makeNcRecords()
    const targets: NcTargetRef[] = [
      { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
    ]
    const center = new NotificationCenter({
      deviceSettings: makeFakeDeviceSettings(),
      records: world.records,
      logger: makeSilentLogger(),
      pruneWindows: ncPruneWindowsPort(),
      dispatcher: {
        listTargets: async () => targets,
        send: async () => ({ success: true }),
        getMediaForOwner: async () => [],
        getDeviceName: async () => 'Termometro sala server',
      },
      listObjectEventsSince: async () => [],
      listRecentTracks: async () => [],
      listDeviceIdentities: async () => [
        { deviceId: 3615, type: DeviceType.Sensor, name: 'Termometro', isCamera: false },
      ],
      drainIntervalMs: 3_600_000,
      ruleReloadIntervalMs: 40,
      // Reminders OFF: the fix must not depend on a reminder ever coming.
      readDeviceAlertSettings: () => ({
        batteryLowPercent: 20,
        renotifyMinutes: 0,
        notifyRecovery: true,
      }),
    })
    centers.push(center)
    await center.start({ evaluation: true })
    const provider = center.buildProvider()
    const created = await provider.createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Eventi di sistema',
        delivery: 'system-event',
        conditions: {
          systemEvent: { kinds: ['device-battery-low'], deviceTypes: ['camera'] },
        },
        targets: [{ targetId: 'target-1' }],
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })

    center.onSystemEvent({
      id: 'battery-slice',
      timestamp: new Date(),
      source: { type: 'device', id: 3615 },
      category: 'device.state-changed',
      data: { deviceId: 3615, capName: 'battery', slice: { percentage: 0, lastUpdated: 5_000 } },
    })
    // Several reload ticks with the rule UNCHANGED: still nothing, and no
    // re-offer storm either.
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    expect(ncTable(world, 'outbox')?.size ?? 0).toBe(0)

    await provider.updateRule({
      caller: { userId: 'admin', isAdmin: true },
      ruleId: created.rule.id,
      patch: { conditions: { systemEvent: { kinds: ['device-battery-low'] } } },
    })

    await vi.waitFor(
      () => {
        expect(ncTable(world, 'outbox')?.size).toBe(1)
      },
      { timeout: 2_000 },
    )
    const row = [...(ncTable(world, 'outbox')?.values() ?? [])][0]
    expect(row?.['payload']).toMatchObject({
      subject: { systemEvent: { kind: 'device-battery-low', subject: 'battery:3615' } },
    })
  })
})
