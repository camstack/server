/**
 * A rule groups system events that arrive within a few seconds (operator, 2026-11-12).
 *
 * The morning this was asked for, on the hub: device-offline at 09:23:20 (3395)
 * and 09:23:22 (3502) are one summary; 09:23:48 (560 and 572, the same
 * millisecond) is another; device-online at 09:29:36 and 09:30:33 likewise.
 * Eight deliveries, four notifications. One delivery in a window keeps its own
 * words and only waits. A detection rule still sends at once.
 */
import {
  createEvent,
  DeviceType,
  NcRuleInputSchema,
  scheduleForSendTimes,
  type SystemEvent,
} from '@camstack/types'
import type { InMemoryRecords } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcDeviceIdentity } from '../device-directory.js'
import type { NcTargetRef } from '../dispatcher.js'
import { GROUP_WINDOW_MEMBER_IDS } from '../group-window-summary.js'
import { NotificationCenter } from '../index.js'
import { NcOutbox } from '../outbox.js'
import { NC_SYSTEM_DEVICE_ID } from '../rule-engine.js'
import {
  NC_STATE_SUMMARY_BODY_KEY,
  NC_STATE_SUMMARY_TITLE_KEY,
} from '../state-summary/state-summary-delivery.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { boot, event, makeHarness, rule } from './grouped-harness.js'
import { makeNcRecords, ncPruneWindowsPort, ncTable } from './support/nc-test-deps.js'

const TARGET = 'target-1'
const PHONE: readonly NcTargetRef[] = [
  { id: TARGET, addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
]
const BOB_PHONE: readonly NcTargetRef[] = [
  {
    id: 'tgt-bob',
    addonId: 'notifiers',
    name: 'bob-phone',
    kind: 'ntfy',
    enabled: true,
    ownerUserId: 'user-bob',
  },
]
const CAMERAS = [3395, 3502, 560, 572] as const
/** 09:23:20 on 2026-11-12, Europe/Rome (UTC+1). */
const BASE = Date.UTC(2026, 10, 12, 8, 23, 20)
const CALLER = { userId: 'admin', isAdmin: true }
const BOB = { userId: 'user-bob', isAdmin: false }
const EIGHT_UTC = scheduleForSendTimes([{ days: [0, 1, 2, 3, 4, 5, 6], minute: 8 * 60 }], 'UTC')

interface Sent {
  readonly title: string
  readonly body: string
}

interface Center {
  readonly center: NotificationCenter
  readonly world: InMemoryRecords
  readonly sent: Sent[]
  readonly clock: { now: number }
}

const centers: NotificationCenter[] = []

afterEach(async () => {
  await Promise.all(centers.map((center) => center.stop()))
  centers.length = 0
})

function sentOf(input: unknown): Sent | null {
  if (typeof input !== 'object' || input === null || !('notification' in input)) return null
  const notification: unknown = input.notification
  if (
    typeof notification !== 'object' ||
    notification === null ||
    !('title' in notification) ||
    !('body' in notification)
  ) {
    return null
  }
  return typeof notification.title === 'string' && typeof notification.body === 'string'
    ? { title: notification.title, body: notification.body }
    : null
}

function identity(deviceId: number): NcDeviceIdentity {
  return { deviceId, type: DeviceType.Camera, name: String(deviceId), isCamera: true }
}

function liveness(deviceId: number, online: boolean): SystemEvent {
  return createEvent(
    online ? 'device.online' : 'device.offline',
    { type: 'device', id: deviceId },
    { deviceId, providerId: 'reolink' },
  )
}

function outbox(world: InMemoryRecords): readonly Record<string, unknown>[] {
  return [...(ncTable(world, 'outbox')?.values() ?? [])]
}

function deviceIds(world: InMemoryRecords): readonly number[] {
  return outbox(world).flatMap((row) =>
    typeof row['deviceId'] === 'number' ? [row['deviceId']] : [],
  )
}

function open(
  world: InMemoryRecords,
  clock: { now: number },
  sent: Sent[],
  targets: readonly NcTargetRef[],
): NotificationCenter {
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: ncPruneWindowsPort(),
    now: () => clock.now,
    dispatcher: {
      sleep: async () => {},
      listTargets: async () => targets,
      send: async (input) => {
        const notification = sentOf(input)
        if (notification !== null) sent.push(notification)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async (deviceId) => String(deviceId),
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => CAMERAS.map((deviceId) => identity(deviceId)),
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  return center
}

async function start(targets: readonly NcTargetRef[] = PHONE): Promise<Center> {
  const world = makeNcRecords()
  const clock = { now: BASE - 60_000 }
  const sent: Sent[] = []
  const center = open(world, clock, sent, targets)
  await center.start({ evaluation: true })
  await center.whenHydrated()
  return { center, world, sent, clock }
}

async function systemRule(
  center: NotificationCenter,
  extra: Record<string, unknown> = {},
  targetId = TARGET,
): Promise<string> {
  const created = await center.buildProvider().createRule({
    caller: CALLER,
    rule: NcRuleInputSchema.parse({
      name: 'Dispositivi',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['device-offline', 'device-online'] } },
      targets: [{ targetId }],
      media: { attach: 'none' },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
      ...extra,
    }),
  })
  return created.rule.id
}

async function untilDevices(world: InMemoryRecords, ids: readonly number[]): Promise<void> {
  await vi.waitFor(() => expect(deviceIds(world)).toEqual([...ids]), { timeout: 2_000 })
}

/** Let a 0 ms liveness hold-off (the vitest delay) flush onto the evaluation chain. */
async function holdoff(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

async function seedOnline(box: Center): Promise<void> {
  for (const deviceId of CAMERAS) box.center.onSystemEvent(liveness(deviceId, true))
  await holdoff()
  await box.center.runDrainTickForTest()
  expect(outbox(box.world)).toHaveLength(0)
}

describe('a system rule groups deliveries that arrive within a few seconds', () => {
  it('the 2026-11-12 morning is four summaries, not eight notifications', async () => {
    const box = await start()
    const ruleId = await systemRule(box.center)
    await seedOnline(box)

    box.clock.now = BASE
    box.center.onSystemEvent(liveness(3395, false))
    box.center.onSystemEvent(liveness(3502, false))
    await untilDevices(box.world, [3395, 3502])
    await box.center.runDrainTickForTest()
    expect(box.sent).toHaveLength(0)

    box.clock.now = BASE + 5_000
    await box.center.runDrainTickForTest()
    expect(box.sent.map((sent) => sent.title)).toEqual(['2 devices offline'])
    expect(box.sent[0]?.body).toContain('Offline or off')
    expect(box.sent[0]?.body).toContain('Offline or off')
    expect(box.sent[0]?.body).toContain('3395')
    expect(box.sent[0]?.body).toContain('3502')

    box.clock.now = BASE + 28_000
    box.center.onSystemEvent(liveness(560, false))
    box.center.onSystemEvent(liveness(572, false))
    await vi.waitFor(() => expect(deviceIds(box.world)).toContain(572), { timeout: 2_000 })
    await box.center.runDrainTickForTest()
    expect(box.sent).toHaveLength(1)
    box.clock.now = BASE + 33_000
    await box.center.runDrainTickForTest()
    expect(box.sent).toHaveLength(2)
    expect(box.sent[1]?.body).toContain('560')
    expect(box.sent[1]?.body).toContain('572')

    const beforeOnline = outbox(box.world).length
    box.clock.now = BASE + 376_000
    box.center.onSystemEvent(liveness(3395, true))
    box.center.onSystemEvent(liveness(3502, true))
    await vi.waitFor(() => expect(outbox(box.world)).toHaveLength(beforeOnline + 2), {
      timeout: 2_000,
    })
    box.clock.now = BASE + 381_000
    await box.center.runDrainTickForTest()
    expect(box.sent).toHaveLength(3)
    expect(box.sent[2]?.body).toContain('back online')
    expect(box.sent[2]?.body).not.toContain('Offline or off')

    const beforeSecondOnline = outbox(box.world).length
    box.clock.now = BASE + 433_000
    box.center.onSystemEvent(liveness(560, true))
    box.center.onSystemEvent(liveness(572, true))
    await vi.waitFor(() => expect(outbox(box.world)).toHaveLength(beforeSecondOnline + 2), {
      timeout: 2_000,
    })
    box.clock.now = BASE + 438_000
    await box.center.runDrainTickForTest()
    expect(box.sent).toHaveLength(4)
    expect(box.sent[3]?.title).toBe('2 devices back online')

    const history = await box.center.buildProvider().getHistory({ filter: { ruleId, limit: 50 } })
    const folded = history.entries.filter((entry) => entry.groupedInto !== undefined)
    expect(folded).toHaveLength(8)
    expect(folded.every((entry) => entry.status === 'sent')).toBe(true)
    expect(new Set(folded.map((entry) => entry.groupedInto)).size).toBe(4)
  })

  it('one delivery in the window keeps its own words and only waits', async () => {
    const box = await start()
    await systemRule(box.center)
    await seedOnline(box)
    box.clock.now = BASE
    box.center.onSystemEvent(liveness(3395, false))
    await untilDevices(box.world, [3395])
    await box.center.runDrainTickForTest()
    expect(box.sent).toHaveLength(0)
    box.clock.now = BASE + 5_000
    await box.center.runDrainTickForTest()
    expect(box.sent).toEqual([{ title: 'Offline — 3395', body: expect.any(String) }])
    expect(box.sent[0]?.title).not.toContain('Dispositivi:')
  })

  it('an explicit 0 on a system rule sends each delivery now', async () => {
    const box = await start()
    await systemRule(box.center, { groupWithinSec: 0 })
    await seedOnline(box)
    box.clock.now = BASE
    box.center.onSystemEvent(liveness(3395, false))
    box.center.onSystemEvent(liveness(3502, false))
    await untilDevices(box.world, [3395, 3502])
    await box.center.runDrainTickForTest()
    expect(box.sent.map((sent) => sent.title).toSorted()).toEqual([
      'Offline — 3395',
      'Offline — 3502',
    ])
  })

  it('a restart inside the window still delivers the summary', async () => {
    const box = await start()
    await systemRule(box.center)
    await seedOnline(box)
    box.clock.now = BASE
    box.center.onSystemEvent(liveness(3395, false))
    box.center.onSystemEvent(liveness(3502, false))
    await untilDevices(box.world, [3395, 3502])
    expect(outbox(box.world).every((row) => row['status'] === 'pending')).toBe(true)
    box.center.discardGroupWindowForTest()
    await box.center.stop()
    const next = open(box.world, box.clock, box.sent, PHONE)
    await next.start({ evaluation: true })
    await next.whenHydrated()
    expect(box.sent).toHaveLength(0)
    box.clock.now = BASE + 5_000
    await next.runDrainTickForTest()
    expect(box.sent).toHaveLength(1)
    expect(box.sent[0]?.title).toBe('2 devices offline')
    const held = outbox(box.world).filter(
      (row) => row['deviceId'] === 3395 || row['deviceId'] === 3502,
    )
    expect(held.every((row) => row['status'] === 'sent')).toBe(true)
  })

  it('a summary already written is not written again when the held rows are still pending', async () => {
    const box = await start()
    await systemRule(box.center)
    await seedOnline(box)
    box.clock.now = BASE
    box.center.onSystemEvent(liveness(3395, false))
    box.center.onSystemEvent(liveness(3502, false))
    await untilDevices(box.world, [3395, 3502])
    const table = ncTable(box.world, 'outbox')
    const members: string[] = []
    let ruleId: string | null = null
    let targetId: string | null = null
    for (const [id, data] of table) {
      const payload = data['payload']
      if (typeof payload !== 'object' || payload === null || !('groupHold' in payload)) continue
      members.push(id)
      if (typeof data['ruleId'] === 'string') ruleId = data['ruleId']
      if (typeof data['targetId'] === 'string') targetId = data['targetId']
    }
    expect(members).toHaveLength(2)
    if (ruleId === null || targetId === null) throw new Error('held row has no rule')
    box.center.discardGroupWindowForTest()
    const residue = new NcOutbox({
      records: box.world.records,
      logger: makeSilentLogger(),
      deliver: async () => ({ ok: true }),
      now: () => box.clock.now,
    })
    await residue.enqueue([
      {
        ruleId,
        targetId,
        deviceId: NC_SYSTEM_DEVICE_ID,
        recordKind: 'system-event',
        recordId: 'crash-residue',
        payload: {
          ruleName: 'Dispositivi',
          delivery: 'system-event',
          priority: 3,
          media: 'none',
          subject: {
            deviceId: NC_SYSTEM_DEVICE_ID,
            className: 'system',
            zones: [],
            timestamp: BASE,
            systemEvent: {
              kind: 'device-offline',
              subject: 'group-window:residue',
              titleKey: NC_STATE_SUMMARY_TITLE_KEY,
              bodyKey: NC_STATE_SUMMARY_BODY_KEY,
              textParams: {
                summaryText: 'RESIDUE-MARKER',
                summaryCount: '2',
                summarySection: '',
              },
              textCount: 2,
              data: {
                stateSummary: true,
                groupWindow: true,
                windowStartMs: BASE,
                windowEndMs: BASE,
                [GROUP_WINDOW_MEMBER_IDS]: [...members].sort(),
              },
            },
          },
        },
      },
    ])
    await box.center.stop()
    const next = open(box.world, box.clock, box.sent, PHONE)
    await next.start({ evaluation: true })
    await next.whenHydrated()
    box.clock.now = BASE + 5_000
    await next.runDrainTickForTest()
    expect(box.sent).toHaveLength(1)
    expect(box.sent[0]?.body).toContain('RESIDUE-MARKER')
    const held = outbox(box.world).filter(
      (row) => row['deviceId'] === 3395 || row['deviceId'] === 3502,
    )
    expect(held.every((row) => row['status'] === 'sent')).toBe(true)
  })

  it('a device muted during the window is not in the summary', async () => {
    const box = await start()
    await systemRule(box.center)
    await seedOnline(box)
    box.clock.now = BASE
    for (const deviceId of [3395, 3502, 560]) box.center.onSystemEvent(liveness(deviceId, false))
    await untilDevices(box.world, [3395, 3502, 560])
    await box.center.buildProvider().setDeviceMuted({ deviceId: 3502, muted: true })
    box.clock.now = BASE + 5_000
    await box.center.runDrainTickForTest()
    expect(box.sent).toHaveLength(1)
    expect(box.sent[0]?.body).toContain('3395')
    expect(box.sent[0]?.body).toContain('560')
    expect(box.sent[0]?.body).not.toContain('3502')
    const muted = outbox(box.world).find((row) => row['deviceId'] === 3502)
    expect(muted?.['status']).toBe('dead')
    expect(muted?.['lastError']).toBe('muted')
  })

  it('a digest-only rule does not group, and sends nothing at once', async () => {
    const box = await start()
    box.clock.now = Date.UTC(2026, 10, 12, 3, 0)
    await systemRule(box.center, {
      systemEventDelivery: { mode: 'summary', schedule: EIGHT_UTC },
    })
    await seedOnline(box)
    box.center.onSystemEvent(liveness(3395, false))
    box.center.onSystemEvent(liveness(3502, false))
    await holdoff()
    box.clock.now += 10_000
    await box.center.runDrainTickForTest()
    expect(box.sent).toHaveLength(0)
    expect(outbox(box.world)).toHaveLength(0)
  })

  it('a detection rule still sends at once', async () => {
    const harness = makeHarness()
    centers.push(harness.center)
    await boot(harness, rule({ groupingSec: undefined }))
    harness.center.onObjectEventPersisted(event())
    // The first tick can run before the evaluation has written the row. A second
    // tick is still the same instant — a window of a few seconds would still be holding it.
    await harness.settle()
    await harness.settle()
    expect(harness.sends).toHaveLength(1)
  })

  it('a snoozed rule stays quiet when the window ends', async () => {
    const box = await start(BOB_PHONE)
    const ruleId = await systemRule(box.center, {}, 'tgt-bob')
    await seedOnline(box)
    await box.center.createSnooze({ scope: 'rule', ruleId, durationMinutes: 60 }, BOB)
    box.clock.now = BASE
    box.center.onSystemEvent(liveness(3395, false))
    await untilDevices(box.world, [3395])
    box.clock.now = BASE + 5_000
    await box.center.runDrainTickForTest()
    expect(box.sent).toHaveLength(0)
    expect(ncTable(box.world, 'snooze-suppressed').size).toBe(1)
  })
})
