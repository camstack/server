/**
 * D698 — a summary rule with `split: 'section'` sends one notification per
 * section, through the real centre; `split` absent sends the one D647 row; a
 * restart does not send any section twice; the preview shows the split.
 */
import { ncDurableRecordKinds } from '../nc-durable-record-kinds.js'
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { DeviceType, NcRuleInputSchema, scheduleForSendTimes } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
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

async function started(world: InMemoryRecords, clock: { now: number }, sent: Sent[]) {
  const center = makeCenter(world, clock, sent)
  await center.start({ evaluation: true })
  await center.whenHydrated()
  return center
}

const WINDOW_END = Date.UTC(2026, 9, 1, 8, 0)

function openStates(center: NotificationCenter, now: number): void {
  center.onSystemEvent({
    id: 'battery-slice',
    timestamp: new Date(now),
    source: { type: 'device', id: 3615 },
    category: 'device.state-changed',
    data: { deviceId: 3615, capName: 'battery', slice: { level: 4, lastUpdated: 5_000 } },
  })
  center.onSystemEvent({
    id: 'stream-offline',
    timestamp: new Date(now),
    source: { type: 'device', id: 20 },
    category: 'stream.offline',
    data: { deviceId: 20, camStreamId: 'cam-20-high', profile: 'high', reason: 'stale-timeout' },
  })
}

function summaryRule(split: 'rule' | 'section' | undefined) {
  return NcRuleInputSchema.parse({
    name: 'Stato',
    delivery: 'system-event',
    conditions: {
      systemEvent: { kinds: ['device-battery-low', 'stream-offline', 'device-offline'] },
    },
    systemEventDelivery: {
      mode: 'summary',
      schedule: EIGHT_UTC,
      ...(split !== undefined ? { split } : {}),
    },
    targets: [{ targetId: 'target-1' }],
  })
}

describe('a state summary split per section, through the centre (D698)', () => {
  const centers: NotificationCenter[] = []
  afterEach(async () => {
    await Promise.all(centers.map((center) => center.stop()))
    centers.length = 0
  })

  it("split 'section': one row per non-empty section, each titled by it; a restart sends none again", async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 9, 1, 3, 0) }
    const sent: Sent[] = []
    const center = await started(world, clock, sent)
    centers.push(center)
    const provider = center.buildProvider()
    const created = await provider.createRule({ caller: ADMIN, rule: summaryRule('section') })
    expect(created.rule.systemEventDelivery).toMatchObject({ mode: 'summary', split: 'section' })
    openStates(center, clock.now)

    const preview = await provider.previewStateSummary({ rule: created.rule })
    expect(preview.split).toBe('section')
    expect(preview.rows?.map((row) => row.section)).toEqual(['streams', 'battery'])

    // Let a reload tick ARM the rule before the window closes.
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    clock.now = WINDOW_END + 30_000
    const mine = () => outboxRows(world).filter((row) => row['ruleId'] === created.rule.id)
    await vi.waitFor(() => expect(mine()).toHaveLength(2), { timeout: 2_000 })
    // The device-state section is read and EMPTY: it sends nothing.
    expect(mine().map((row) => row['recordId'])).toEqual(
      expect.arrayContaining([
        `state-summary:${created.rule.id}:${String(WINDOW_END)}:streams`,
        `state-summary:${created.rule.id}:${String(WINDOW_END)}:battery`,
      ]),
    )
    await center.drainNow()
    expect(sent.map((n) => n.title).toSorted()).toEqual(['Low batteries: 1', 'Streams offline: 1'])
    expect(sent.find((n) => n.title === 'Low batteries: 1')?.body).toBe(
      '• Termometro is down to 4% battery',
    )

    // A RESTART over the same store, inside the late grace: no section twice.
    await center.stop()
    const again = await started(world, clock, sent)
    centers.push(again)
    clock.now = WINDOW_END + 120_000
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    expect(mine()).toHaveLength(2)
  })

  it('split absent: the one D647 row, unchanged', async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 9, 1, 3, 0) }
    const sent: Sent[] = []
    const center = await started(world, clock, sent)
    centers.push(center)
    const provider = center.buildProvider()
    const created = await provider.createRule({ caller: ADMIN, rule: summaryRule(undefined) })
    openStates(center, clock.now)
    const preview = await provider.previewStateSummary({ rule: created.rule })
    expect(preview.split).toBe('rule')
    expect(preview.rows).toHaveLength(1)
    // Let a reload tick ARM the rule before the window closes.
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    clock.now = WINDOW_END + 30_000
    const mine = () => outboxRows(world).filter((row) => row['ruleId'] === created.rule.id)
    await vi.waitFor(() => expect(mine()).toHaveLength(1), { timeout: 2_000 })
    expect(mine()[0]?.['recordId']).toBe(`state-summary:${created.rule.id}:${String(WINDOW_END)}`)
    await center.drainNow()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.title).toBe('Stato: 2')
    // D708: history shows the title the phone got. It rendered the frozen
    // params alone and read ": 2" — `{{rule}}` is a row-level variable.
    const history = await provider.getHistory({ filter: { ruleId: created.rule.id, limit: 10 } })
    expect(history.entries.map((entry) => entry.subject.systemEvent?.title)).toEqual(['Stato: 2'])
  })

  it('M4: a crash after ONE section and before the stamp — the replay sends each section exactly once', async () => {
    const world = makeNcRecords()
    const clock = { now: Date.UTC(2026, 9, 1, 3, 0) }
    const sent: Sent[] = []
    const center = await started(world, clock, sent)
    centers.push(center)
    const created = await center.buildProvider().createRule({
      caller: ADMIN,
      rule: summaryRule('section'),
    })
    openStates(center, clock.now)
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    clock.now = WINDOW_END + 30_000
    const mine = () => outboxRows(world).filter((row) => row['ruleId'] === created.rule.id)
    await vi.waitFor(() => expect(mine()).toHaveLength(2), { timeout: 2_000 })
    await center.stop()

    // Rewind the store to the crash: the battery row never landed, and neither
    // did the stamp — the streams row did.
    const outbox = world.records.kind(ncDurableRecordKinds.outbox)
    for (const [id, row] of ncTable(world, 'outbox')) {
      if (row['recordId'] === `state-summary:${created.rule.id}:${String(WINDOW_END)}:battery`) {
        await outbox.delete(id)
      }
    }
    const stamp = ncTable(world, 'state-summary-stamps').get(created.rule.id)
    if (stamp === undefined) throw new Error('no stamp')
    world.seed('state-summary-stamps', {
      id: created.rule.id,
      data: { ...stamp, lastWindowEnd: 0 },
    })
    expect(mine()).toHaveLength(1)

    const again = await started(world, clock, sent)
    centers.push(again)
    clock.now = WINDOW_END + 90_000
    await vi.waitFor(() => expect(mine()).toHaveLength(2), { timeout: 2_000 })
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    // Each section exactly once: the replay re-enqueued streams (deduped) and battery.
    expect(
      mine()
        .map((row) => row['recordId'])
        .toSorted(),
    ).toEqual([
      `state-summary:${created.rule.id}:${String(WINDOW_END)}:battery`,
      `state-summary:${created.rule.id}:${String(WINDOW_END)}:streams`,
    ])
    expect(ncTable(world, 'state-summary-stamps')?.get(created.rule.id)?.['lastWindowEnd']).toBe(
      WINDOW_END,
    )
  })
})
