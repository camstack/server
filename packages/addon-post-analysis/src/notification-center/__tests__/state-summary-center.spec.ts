/**
 * D647 end to end through the real centre: a summary rule sends NOTHING per
 * event, the instant rule beside it on the same kind is untouched, and at the
 * end of the window the current state goes out ONCE through the ordinary
 * outbox — rendered with the rule's own template — and a restart does not
 * send it again.
 */
import type { InMemoryRecords } from '@camstack/types'
import { DeviceType, NcRuleInputSchema, scheduleForSendTimes } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcTargetRef } from '../dispatcher.js'
import { ncPruneWindowsPort, makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const TARGETS: NcTargetRef[] = [
  { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
]

interface SentNotification {
  readonly title: string
  readonly body: string
}

function sentOf(input: unknown): SentNotification | null {
  if (typeof input !== 'object' || input === null || !('notification' in input)) return null
  const n: unknown = input.notification
  if (typeof n !== 'object' || n === null || !('title' in n) || !('body' in n)) return null
  return typeof n.title === 'string' && typeof n.body === 'string'
    ? { title: n.title, body: n.body }
    : null
}

function makeCenter(
  world: InMemoryRecords,
  clock: { now: number },
  sent: SentNotification[],
  logger = makeSilentLogger(),
) {
  return new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger,
    pruneWindows: ncPruneWindowsPort(),
    now: () => clock.now,
    dispatcher: {
      listTargets: async () => TARGETS,
      send: async (input: unknown) => {
        const notification = sentOf(input)
        if (notification !== null) sent.push(notification)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Termometro',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [
      { deviceId: 3615, type: DeviceType.Sensor, name: 'Termometro', isCamera: false },
      { deviceId: 20, type: DeviceType.Camera, name: 'Front door', isCamera: true },
    ],
    readNodeDirectory: async () => ({
      nodes: [{ id: 'hub', name: 'hub', isHub: true, isOnline: true }],
      complete: true,
    }),
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 40,
    readDeviceAlertSettings: () => ({
      batteryLowPercent: 20,
      renotifyMinutes: 0,
      notifyRecovery: true,
    }),
  })
}

function outboxRows(world: InMemoryRecords): readonly Record<string, unknown>[] {
  return [...(ncTable(world, 'outbox')?.values() ?? [])]
}

const EIGHT_UTC = scheduleForSendTimes([{ days: [0, 1, 2, 3, 4, 5, 6], minute: 8 * 60 }], 'UTC')

describe('a scheduled state summary, through the centre', () => {
  const centers: NotificationCenter[] = []
  afterEach(async () => {
    await Promise.all(centers.map((center) => center.stop()))
    centers.length = 0
  })

  it('holds its own instant notification, leaves the instant rule alone, sends once at 08:00, survives a restart', async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 8, 25, 3, 0) }
    const sent: SentNotification[] = []
    const center = makeCenter(world, clock, sent)
    centers.push(center)
    await center.start({ evaluation: true })
    await center.whenHydrated()
    const provider = center.buildProvider()
    const caller = { userId: 'admin', isAdmin: true }
    const summary = await provider.createRule({
      caller,
      rule: NcRuleInputSchema.parse({
        name: 'Stato batterie',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-battery-low'] } },
        systemEventDelivery: { mode: 'summary', schedule: EIGHT_UTC },
        targets: [{ targetId: 'target-1' }],
        template: { body: '{{summaryCount}} — {{summaryBattery}}' },
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })
    const instant = await provider.createRule({
      caller,
      rule: NcRuleInputSchema.parse({
        name: 'Batteria subito',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-battery-low'] } },
        targets: [{ targetId: 'target-1' }],
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })

    center.onSystemEvent({
      id: 'battery-slice',
      timestamp: new Date(clock.now),
      source: { type: 'device', id: 3615 },
      category: 'device.state-changed',
      data: { deviceId: 3615, capName: 'battery', slice: { level: 4, lastUpdated: 5_000 } },
    })
    // The INSTANT rule fired; the summary rule said nothing.
    await vi.waitFor(() => expect(outboxRows(world)).toHaveLength(1), { timeout: 2_000 })
    expect(outboxRows(world)[0]?.['ruleId']).toBe(instant.rule.id)
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    expect(outboxRows(world).filter((row) => row['ruleId'] === summary.rule.id)).toHaveLength(0)

    // 08:00:30 — the window closed; the next reload tick sends the state.
    clock.now = Date.UTC(2026, 8, 25, 8, 0, 30)
    const windowEnd = Date.UTC(2026, 8, 25, 8, 0)
    await vi.waitFor(
      () =>
        expect(outboxRows(world).filter((row) => row['ruleId'] === summary.rule.id)).toHaveLength(
          1,
        ),
      { timeout: 2_000 },
    )
    const row = outboxRows(world).find((r) => r['ruleId'] === summary.rule.id)
    expect(row?.['recordKind']).toBe('system-event')
    expect(row?.['recordId']).toBe(`state-summary:${summary.rule.id}:${windowEnd}`)
    expect(row?.['payload']).toMatchObject({
      subject: {
        systemEvent: {
          titleKey: 'system.state-summary.title',
          textParams: { summaryCount: '1', summaryBattery: expect.stringContaining('Termometro') },
          data: { stateSummary: true, windowEndMs: windowEnd },
        },
      },
    })
    // Delivered through the ordinary drain, rendered with the rule's template.
    await center.drainNow()
    // The shipped title is `system.state-summary.title`: "{{rule}}: {{summaryCount}}".
    const delivered = sent.find((n) => n.title === 'Stato batterie: 1')
    expect(delivered?.body).toMatch(/^1 — Low batteries:\n• Termometro is down to 4% battery$/)

    // More ticks: still one. Then a RESTART over the same store: still one.
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    await center.stop()
    const again = makeCenter(world, clock, sent)
    centers.push(again)
    await again.start({ evaluation: true })
    await again.whenHydrated()
    clock.now = Date.UTC(2026, 8, 25, 8, 5)
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    expect(outboxRows(world).filter((r) => r['ruleId'] === summary.rule.id)).toHaveLength(1)
  })

  it('a raise only a summary rule covers is HEARD — not kept pending and re-offered every hour', async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 8, 25, 3, 0) }
    const center = makeCenter(world, clock, [])
    centers.push(center)
    await center.start({ evaluation: true })
    await center.whenHydrated()
    await center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Stato batterie',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-battery-low'] } },
        systemEventDelivery: { mode: 'summary', schedule: EIGHT_UTC },
        targets: [{ targetId: 'target-1' }],
      }),
    })
    center.onSystemEvent({
      id: 'battery-slice',
      timestamp: new Date(clock.now),
      source: { type: 'device', id: 3615 },
      category: 'device.state-changed',
      data: { deviceId: 3615, capName: 'battery', slice: { level: 4, lastUpdated: 5_000 } },
    })
    // Let the door answer and the row settle (a refused raise is put back to 0).
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    expect(ncTable(world, 'device-alerts')?.get('battery:3615')).toMatchObject({
      alerting: 1,
      lastNotifiedAt: clock.now,
    })
    expect(outboxRows(world)).toHaveLength(0)
  })

  it('nothing open: no row is enqueued, and the centre says why', async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 8, 25, 7, 58) }
    const logger = makeSilentLogger()
    const info = vi.spyOn(logger, 'info')
    const center = makeCenter(world, clock, [], logger)
    centers.push(center)
    await center.start({ evaluation: true })
    await center.whenHydrated()
    await center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Stato',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-battery-low', 'stream-offline'] } },
        systemEventDelivery: { mode: 'summary', schedule: EIGHT_UTC },
        targets: [{ targetId: 'target-1' }],
      }),
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 120))
    clock.now = Date.UTC(2026, 8, 25, 8, 1)
    await vi.waitFor(
      () =>
        expect(info).toHaveBeenCalledWith(
          'state summary has nothing to report — not sent',
          expect.anything(),
        ),
      { timeout: 2_000 },
    )
    expect(outboxRows(world)).toHaveLength(0)
  })

  it('both save routes refuse a summary on an alarm rule', async () => {
    const world = makeNcRecords()
    const center = makeCenter(world, { now: Date.now() }, [])
    centers.push(center)
    await center.start({ evaluation: false })
    await expect(
      center.buildProvider().createRule({
        caller: { userId: 'admin', isAdmin: true },
        rule: NcRuleInputSchema.parse({
          name: 'Allarme',
          delivery: 'system-event',
          conditions: { systemEvent: { kinds: ['alarm-triggered'] } },
          systemEventDelivery: { mode: 'summary', schedule: EIGHT_UTC },
          targets: [{ targetId: 'target-1' }],
        }),
      }),
    ).rejects.toThrow(/alarm stays instant/)
  })

  it('the intake reconciles the ledger before its gates: first-packet online, update lists (review I1/I3)', async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 8, 25, 3, 0) }
    const center = makeCenter(world, clock, [])
    centers.push(center)
    await center.start({ evaluation: true })
    await center.whenHydrated()
    const preview = (kinds: readonly string[]) =>
      center.buildProvider().previewStateSummary({
        rule: NcRuleInputSchema.parse({
          name: 'Bozza',
          delivery: 'system-event',
          conditions: { systemEvent: { kinds } },
          systemEventDelivery: { mode: 'summary', schedule: EIGHT_UTC },
          targets: [{ targetId: 'target-1' }],
        }),
      })
    const stream = (category: 'stream.offline' | 'stream.online', reason: string) =>
      center.onSystemEvent({
        id: `${category}-${reason}`,
        timestamp: new Date(clock.now),
        source: { type: 'device', id: 20 },
        category,
        data: { deviceId: 20, camStreamId: 'cam-20-high', profile: 'high', reason },
      })
    stream('stream.offline', 'stale-timeout')
    expect((await preview(['stream-offline'])).count).toBe(1)
    // A recreated broker's first packet: no notification, but the stream is UP.
    stream('stream.online', 'first-packet')
    expect((await preview(['stream-offline'])).count).toBe(0)

    const updates = (packages: readonly Record<string, string>[]) =>
      center.onSystemEvent({
        id: `update-${String(packages.length)}`,
        timestamp: new Date(clock.now),
        source: { type: 'system', id: 'hub' },
        category: 'update.available',
        data: { target: 'addon', nodeId: 'hub', packages },
      })
    updates([
      {
        packageName: '@camstack/addon-recorder',
        currentVersion: '1',
        latestVersion: '2',
        nodeId: 'hub',
      },
    ])
    expect((await preview(['addon-update-available'])).count).toBe(1)
    updates([])
    expect((await preview(['addon-update-available'])).count).toBe(0)
  })

  it('a custom body with no summary content gets it appended; a rule reaching nobody WARNS (review M3)', async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 8, 25, 7, 0) }
    const sent: SentNotification[] = []
    const logger = makeSilentLogger()
    const warn = vi.spyOn(logger, 'warn')
    const center = makeCenter(world, clock, sent, logger)
    centers.push(center)
    await center.start({ evaluation: true })
    await center.whenHydrated()
    const provider = center.buildProvider()
    const caller = { userId: 'admin', isAdmin: true }
    const base = {
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['device-battery-low'] } },
      systemEventDelivery: { mode: 'summary', schedule: EIGHT_UTC },
    }
    const greeted = await provider.createRule({
      caller,
      rule: NcRuleInputSchema.parse({
        ...base,
        name: 'Buongiorno',
        targets: [{ targetId: 'target-1' }],
        template: { body: 'Buongiorno' },
      }),
    })
    await provider.createRule({
      caller,
      rule: NcRuleInputSchema.parse({
        ...base,
        name: 'Solo utenti',
        targets: [],
        targetUsers: ['u1'],
      }),
    })
    center.onSystemEvent({
      id: 'battery-slice',
      timestamp: new Date(clock.now),
      source: { type: 'device', id: 3615 },
      category: 'device.state-changed',
      data: { deviceId: 3615, capName: 'battery', slice: { level: 4, lastUpdated: 5_000 } },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 120))
    clock.now = Date.UTC(2026, 8, 25, 8, 0, 30)
    await vi.waitFor(() => expect(outboxRows(world)).toHaveLength(1), { timeout: 2_000 })
    expect(outboxRows(world)[0]?.['ruleId']).toBe(greeted.rule.id)
    await center.drainNow()
    expect(sent.find((n) => n.title === 'Buongiorno: 1')?.body).toMatch(
      /^Buongiorno\nLow batteries:\n• Termometro/,
    )
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'state summary reached NO target — its users are not admins, and it has no targets',
        expect.anything(),
      ),
    )
  })

  it('previewStateSummary answers the draft as it would be sent now — and sends nothing', async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 8, 25, 3, 0) }
    const center = makeCenter(world, clock, [])
    centers.push(center)
    await center.start({ evaluation: true })
    await center.whenHydrated()
    center.onSystemEvent({
      id: 'battery-slice',
      timestamp: new Date(clock.now),
      source: { type: 'device', id: 3615 },
      category: 'device.state-changed',
      data: { deviceId: 3615, capName: 'battery', slice: { level: 4, lastUpdated: 5_000 } },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    const preview = await center.buildProvider().previewStateSummary({
      rule: NcRuleInputSchema.parse({
        name: 'Bozza',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-battery-low'] } },
        systemEventDelivery: { mode: 'summary', schedule: EIGHT_UTC },
        targets: [{ targetId: 'target-1' }],
      }),
    })
    expect(preview).toMatchObject({ empty: false, count: 1, excludedGroups: [] })
    expect(preview.text).toContain('Termometro')
    expect(outboxRows(world)).toHaveLength(0)
  })
})
