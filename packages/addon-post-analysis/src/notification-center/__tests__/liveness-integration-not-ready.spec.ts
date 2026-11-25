/**
 * A RESTART MUST NOT TELL THE OPERATOR THAT DEVICES CAME ONLINE (planning#718).
 *
 * 2026-11-25, hub restarted 15:17Z. Contact sensor 5380 was offline and had
 * been announced so. A `device-online` armed its 90 s window at 15:18:27; ten
 * seconds later the provider's `unknown` slice (the integration had not
 * answered) was dropped by the intake gate WITHOUT touching the pending flip,
 * and "online" was delivered at 15:19:57 for a device that is offline. About
 * 35 more devices did the same, grouped into one "35 devices online".
 *
 * An unknown slice means the integration has not answered: whatever flip is
 * pending for that device is stale, and nothing may arm until it answers.
 */
import type { InMemoryRecords } from '@camstack/types'
import { createEvent, DeviceType, NcRuleInputSchema, type SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NotificationCenter } from '../index.js'
import { DEVICE_LIVENESS_HOLDOFF_MS } from '../liveness-holdoff.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { makeNcRecords, ncPruneWindowsPort, ncTable } from './support/nc-test-deps.js'

const IDS = [5380, 5381, 5382, 5383] as const
const WINDOW = DEVICE_LIVENESS_HOLDOFF_MS

const TARGETS = [
  {
    id: 'target-1',
    addonId: 'notifiers',
    name: 'phone',
    kind: 'ntfy',
    enabled: true,
  },
] as const

const centers: NotificationCenter[] = []

afterEach(async () => {
  await Promise.all(centers.map((center) => center.stop()))
  centers.length = 0
  vi.useRealTimers()
})

async function startCenter(world: InMemoryRecords): Promise<NotificationCenter> {
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: ncPruneWindowsPort(),
    livenessHoldoffMs: WINDOW,
    dispatcher: {
      listTargets: async () => [...TARGETS],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Sensor',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () =>
      IDS.map((deviceId) => ({
        deviceId,
        type: DeviceType.Sensor,
        name: `Sensor ${deviceId}`,
        isCamera: false,
        online: true,
      })),
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: true })
  await center.whenHydrated()
  await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Liveness',
      delivery: 'system-event',
      conditions: {
        systemEvent: { kinds: ['device-online', 'device-offline'] },
      },
      targets: [{ targetId: 'target-1' }],
      media: { attach: 'none' },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
    }),
  })
  return center
}

function liveness(deviceId: number, online: boolean): SystemEvent {
  return createEvent(
    online ? 'device.online' : 'device.offline',
    { type: 'device', id: deviceId },
    { deviceId, providerId: 'provider-mqtt-ha' },
  )
}

let sliceSeq = 0
function statusSlice(deviceId: number, slice: Record<string, unknown>): SystemEvent {
  sliceSeq += 1
  return {
    id: `status-${deviceId}-${sliceSeq}`,
    timestamp: new Date(Date.now()),
    source: { type: 'device', id: deviceId },
    category: 'device.state-changed',
    data: { deviceId, capName: 'device-status', slice },
  }
}

function unknownSlice(deviceId: number): SystemEvent {
  return statusSlice(deviceId, {
    online: false,
    lastChangedAt: 1,
    unknown: true,
  })
}

/** The previous process announced every device offline, long enough ago. */
async function announcedOffline(world: InMemoryRecords): Promise<void> {
  baseline = 0
  const first = await startCenter(world)
  for (const id of IDS) first.onSystemEvent(liveness(id, false))
  await vi.advanceTimersByTimeAsync(WINDOW + 1_000)
  await vi.waitFor(() => {
    expect(outboxCount(world)).toBeGreaterThanOrEqual(IDS.length)
  })
  await first.stop()
  await vi.advanceTimersByTimeAsync(WINDOW)
  baseline = outboxCount(world)
}

/** Rows the first process already delivered; assertions count only what is NEW. */
let baseline = 0

function outboxCount(world: InMemoryRecords): number {
  return ncTable(world, 'outbox').size
}

function announced(world: InMemoryRecords): number {
  return outboxCount(world) - baseline
}

describe('a pending liveness flip does not survive an unknown slice (planning#718)', () => {
  it('THE INCIDENT 5380: hydrated online, then the integration says unknown: nothing is announced', async () => {
    vi.useFakeTimers()
    const world = makeNcRecords()
    await announcedOffline(world)

    const center = await startCenter(world)
    center.onSystemEvent(liveness(5380, true))
    await vi.advanceTimersByTimeAsync(11_000)
    center.onSystemEvent(unknownSlice(5380))
    await vi.advanceTimersByTimeAsync(6 * 60_000)

    expect(announced(world)).toBe(0)
  })

  it('THE GROUP: devices that flap online then unknown at boot are not announced as a group', async () => {
    vi.useFakeTimers()
    const world = makeNcRecords()
    await announcedOffline(world)

    const center = await startCenter(world)
    for (const id of IDS) center.onSystemEvent(liveness(id, true))
    await vi.advanceTimersByTimeAsync(5_000)
    for (const id of IDS) center.onSystemEvent(unknownSlice(id))
    await vi.advanceTimersByTimeAsync(6 * 60_000)

    expect(announced(world)).toBe(0)
  })

  it('an online that arrives while the integration is not ready arms nothing until it answers', async () => {
    vi.useFakeTimers()
    const world = makeNcRecords()
    await announcedOffline(world)

    const center = await startCenter(world)
    center.onSystemEvent(unknownSlice(5380))
    center.onSystemEvent(liveness(5380, true))
    await vi.advanceTimersByTimeAsync(WINDOW * 3)
    expect(announced(world)).toBe(0)
  })

  it('control: once the integration answers, a state that differs holds the full window then is announced', async () => {
    vi.useFakeTimers()
    const world = makeNcRecords()
    await announcedOffline(world)

    const center = await startCenter(world)
    center.onSystemEvent(unknownSlice(5380))
    await vi.advanceTimersByTimeAsync(30_000)
    center.onSystemEvent(statusSlice(5380, { online: true, lastChangedAt: 2 }))
    await vi.advanceTimersByTimeAsync(WINDOW - 1_000)
    expect(announced(world)).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => {
      expect(announced(world)).toBeGreaterThan(0)
    })
  })
})
