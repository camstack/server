/**
 * D698 — pressing TEST on a STATE-SUMMARY rule delivers the summary.
 *
 * ## The bug (operator report, traced on the hub)
 *
 * `nc.testRule` planned ONE synthetic system event and injected it. A summary
 * rule sends nothing per event (D647), so the event was held for the summary
 * and dropped: the test could never deliver anything for a summary rule, and
 * nothing said so.
 *
 * The test of a summary rule now builds the summary NOW — the path
 * `previewStateSummary` reads — and enqueues it through the ordinary outbox
 * under a test record id that no real window can take; nothing to report is an
 * ANSWER, never a silence.
 */
import type { InMemoryRecords } from '@camstack/types'
import { ncRecordKinds } from '../record-kinds.js'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { DeviceType, NcRuleInputSchema, scheduleForSendTimes } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { makeNcActionHandlers, type NcActionHandlers } from '../nc-actions.js'
import { NcRuleAiStore } from '../rule-ai-store.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const ADMIN = { userId: 'admin', isAdmin: true }
const TARGETS: NcTargetRef[] = [
  { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
]
const EIGHT_UTC = scheduleForSendTimes([{ days: [0, 1, 2, 3, 4, 5, 6], minute: 8 * 60 }], 'UTC')

interface Sent {
  readonly title: string
  readonly body: string
}

function sentOf(input: unknown): Sent | null {
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
  sent: Sent[],
  ruleReloadIntervalMs = 3_600_000,
): NotificationCenter {
  return new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: async () => ({
      outboxMs: null,
      timelapseExportMs: null,
      artifactShelfMs: null,
      summaryMosaicMs: null,
    }),
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
    ],
    readNodeDirectory: async () => ({
      nodes: [{ id: 'hub', name: 'hub', isHub: true, isOnline: true }],
      complete: true,
    }),
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs,
    readDeviceAlertSettings: () => ({
      batteryLowPercent: 20,
      renotifyMinutes: 0,
      notifyRecovery: true,
    }),
  })
}

function handlersOf(center: NotificationCenter, world: InMemoryRecords): NcActionHandlers {
  return makeNcActionHandlers({
    ruleStore: center.ruleStore,
    ruleAiStore: new NcRuleAiStore({
      kind: world.records.kind(ncRecordKinds['rule-ai']),
      logger: makeSilentLogger(),
    }),
    logger: makeSilentLogger(),
    listCallerTargetIds: async () => [],
    snooze: {
      list: () => [],
      create: () => Promise.reject(new Error('unused')),
      cancel: () => Promise.resolve(),
    },
    injectTestEvent: (input) => center.injectTestEvent(input),
    testStateSummary: (rule) => center.testStateSummary(rule),
  })
}

function outboxRows(world: InMemoryRecords): readonly Record<string, unknown>[] {
  return [...(ncTable(world, 'outbox')?.values() ?? [])]
}

async function started(world: InMemoryRecords, clock: { now: number }, sent: Sent[]) {
  const center = makeCenter(world, clock, sent)
  await center.start({ evaluation: true })
  await center.whenHydrated()
  return center
}

describe('TEST on a state-summary rule (D698)', () => {
  const centers: NotificationCenter[] = []
  afterEach(async () => {
    await Promise.all(centers.map((center) => center.stop()))
    centers.length = 0
  })

  it('builds the summary NOW and delivers it through the outbox to the rule targets', async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 9, 1, 15, 0) }
    const sent: Sent[] = []
    const center = await started(world, clock, sent)
    centers.push(center)
    const created = await center.buildProvider().createRule({
      caller: ADMIN,
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
      data: { deviceId: 3615, capName: 'battery', slice: { percentage: 4, lastUpdated: 5_000 } },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    const result = await handlersOf(center, world)['nc.testRule'](
      { ruleId: created.rule.id },
      ADMIN,
    )

    const rows = outboxRows(world).filter((row) => row['ruleId'] === created.rule.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['recordId']).toBe(`state-summary-test:${created.rule.id}:${String(clock.now)}`)
    expect(result.trigger).toBe('state-summary')
    expect(result.outcomes[0]).toMatchObject({ matched: true, enqueued: 1, cooldown: 'bypassed' })
    expect(result.stateSummary).toMatchObject({ nothingToReport: false, rows: [{ enqueued: 1 }] })
    // Marked as a TEST exactly like every other rule test (review M5).
    expect(rows[0]?.['payload']).toMatchObject({ synthetic: true })
    await center.drainNow()
    const body = sent.find((n) => n.title === 'Stato batterie: 1')?.body
    expect(body?.startsWith('[TEST] ')).toBe(true)
    expect(body).toContain('Termometro is down to 4% battery')
    // A test touches no stamp: the next real window is still owed (review L7).
    expect(
      ncTable(world, 'state-summary-stamps')?.get(created.rule.id)?.['lastWindowEnd'] ?? 0,
    ).toBe(0)
  })

  it("split 'section': the test sends one row per non-empty section, like the real window", async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 9, 1, 15, 0) }
    const center = await started(world, clock, [])
    centers.push(center)
    const created = await center.buildProvider().createRule({
      caller: ADMIN,
      rule: NcRuleInputSchema.parse({
        name: 'Stato',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-battery-low', 'stream-offline'] } },
        systemEventDelivery: { mode: 'summary', schedule: EIGHT_UTC, split: 'section' },
        targets: [{ targetId: 'target-1' }],
      }),
    })
    center.onSystemEvent({
      id: 'battery-slice',
      timestamp: new Date(clock.now),
      source: { type: 'device', id: 3615 },
      category: 'device.state-changed',
      data: { deviceId: 3615, capName: 'battery', slice: { percentage: 4, lastUpdated: 5_000 } },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    const result = await handlersOf(center, world)['nc.testRule'](
      { ruleId: created.rule.id },
      ADMIN,
    )
    // Streams is read and empty: only the battery row.
    expect(result.stateSummary?.split).toBe('section')
    expect(result.stateSummary?.rows).toEqual([
      expect.objectContaining({
        recordId: `state-summary-test:${created.rule.id}:${String(clock.now)}:battery`,
        section: 'battery',
        enqueued: 1,
      }),
    ])
  })

  it('a MUTED camera is in the test summary — the mute is bypassed, as every rule test bypasses it', async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 9, 1, 15, 0) }
    const center = await started(world, clock, [])
    centers.push(center)
    const provider = center.buildProvider()
    const created = await provider.createRule({
      caller: ADMIN,
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
      data: { deviceId: 3615, capName: 'battery', slice: { percentage: 4, lastUpdated: 5_000 } },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    await provider.setDeviceMuted({ deviceId: 3615, muted: true })
    const preview = await provider.previewStateSummary({ rule: created.rule })
    expect(preview.empty).toBe(true)
    const result = await handlersOf(center, world)['nc.testRule'](
      { ruleId: created.rule.id },
      ADMIN,
    )
    expect(result.stateSummary?.nothingToReport).toBe(false)
    expect(outboxRows(world).filter((row) => row['ruleId'] === created.rule.id)).toHaveLength(1)
  })

  it('nothing to report is ANSWERED, per section — never a silent nothing', async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 9, 1, 15, 0) }
    const center = await started(world, clock, [])
    centers.push(center)
    const created = await center.buildProvider().createRule({
      caller: ADMIN,
      rule: NcRuleInputSchema.parse({
        name: 'Stato',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-battery-low', 'stream-offline'] } },
        systemEventDelivery: { mode: 'summary', schedule: EIGHT_UTC },
        targets: [{ targetId: 'target-1' }],
      }),
    })
    const result = await handlersOf(center, world)['nc.testRule'](
      { ruleId: created.rule.id },
      ADMIN,
    )
    expect(outboxRows(world)).toHaveLength(0)
    expect(result.droppedBy).toBe('nothing-to-report')
    expect(result.stateSummary?.nothingToReport).toBe(true)
    expect(result.stateSummary?.sections).toEqual([
      expect.objectContaining({ id: 'streams', status: 'read', items: 0 }),
      expect.objectContaining({ id: 'battery', status: 'read', items: 0 }),
    ])
    expect(result.notes.join('\n')).toMatch(/nothing to report/)
  })

  it('an INSTANT system rule is tested as before — one injected event', async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 9, 1, 15, 0) }
    const center = await started(world, clock, [])
    centers.push(center)
    const created = await center.buildProvider().createRule({
      caller: ADMIN,
      rule: NcRuleInputSchema.parse({
        name: 'Batteria subito',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-battery-low'] } },
        targets: [{ targetId: 'target-1' }],
      }),
    })
    const result = await handlersOf(center, world)['nc.testRule'](
      { ruleId: created.rule.id },
      ADMIN,
    )
    expect(result.recordId.startsWith('synthetic:')).toBe(true)
    expect(result.stateSummary).toBeUndefined()
    expect(result.outcomes[0]).toMatchObject({ matched: true, enqueued: 1 })
  })

  it('R1: a TEST leaves the next real window owed — its row lands beside the test row, and the stamp moves', async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 9, 1, 15, 0) }
    // Ticking reloads: the scheduler arms and sends on its own.
    const center = makeCenter(world, clock, [], 40)
    centers.push(center)
    await center.start({ evaluation: true })
    await center.whenHydrated()
    const created = await center.buildProvider().createRule({
      caller: ADMIN,
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
      data: { deviceId: 3615, capName: 'battery', slice: { percentage: 4, lastUpdated: 5_000 } },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    await handlersOf(center, world)['nc.testRule']({ ruleId: created.rule.id }, ADMIN)
    // Armed on a reload tick, then the next 08:00 closes.
    await vi.waitFor(
      () => expect(ncTable(world, 'state-summary-stamps')?.get(created.rule.id)).toBeDefined(),
      { timeout: 2_000 },
    )
    const windowEnd = Date.UTC(2026, 9, 2, 8, 0)
    clock.now = windowEnd + 30_000
    const ids = () =>
      outboxRows(world)
        .filter((row) => row['ruleId'] === created.rule.id)
        .map((row) => row['recordId'])
    await vi.waitFor(
      () =>
        expect(ids()).toEqual(
          expect.arrayContaining([
            `state-summary-test:${created.rule.id}:${String(Date.UTC(2026, 9, 1, 15, 0))}`,
            `state-summary:${created.rule.id}:${String(windowEnd)}`,
          ]),
        ),
      { timeout: 3_000 },
    )
    await vi.waitFor(
      () =>
        expect(
          ncTable(world, 'state-summary-stamps')?.get(created.rule.id)?.['lastWindowEnd'],
        ).toBe(windowEnd),
      { timeout: 2_000 },
    )
  })
})
