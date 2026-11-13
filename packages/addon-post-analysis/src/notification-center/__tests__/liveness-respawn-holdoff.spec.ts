/**
 * A RESPAWN MUST NOT ANNOUNCE A RECOVERY FROM AN OUTAGE NOBODY ANNOUNCED.
 *
 * 2026-11-12, 18:23Z: the post-analysis runner was respawned by an update.
 * The previous process had accepted an `offline` for 65 devices (the
 * provider's own restart) and was killed 40 s later — before its 5-minute
 * hold-off matured, so not one offline was notified. The new process read the
 * ledger's ACCEPTED `offline` as if it had been NOTIFIED, and the devices
 * coming back 30 s later were delivered as 65 "back online" pushes.
 *
 * An offline row younger than the hold-off delay can never have been
 * notified: it hydrates as a silent bounce. An older one was (or would have
 * been) announced, and its recovery still is.
 */
import type { InMemoryRecords } from '@camstack/types'
import { createEvent, DeviceType, NcRuleInputSchema, type SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NotificationCenter } from '../index.js'
import { DEVICE_LIVENESS_HOLDOFF_MS } from '../liveness-holdoff.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { makeNcRecords, ncPruneWindowsPort, ncTable } from './support/nc-test-deps.js'

const DEVICE_ID = 108

const TARGETS = [
  { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
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
    livenessHoldoffMs: DEVICE_LIVENESS_HOLDOFF_MS,
    dispatcher: {
      listTargets: async () => [...TARGETS],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Camera',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [
      {
        deviceId: DEVICE_ID,
        type: DeviceType.Camera,
        name: 'Camera 108',
        isCamera: true,
        online: true,
      },
    ],
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: true })
  await center.whenHydrated()
  return center
}

async function createLivenessRule(center: NotificationCenter): Promise<void> {
  await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Camera liveness',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['device-online', 'device-offline'] } },
      targets: [{ targetId: 'target-1' }],
      media: { attach: 'none' },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
    }),
  })
}

function liveness(online: boolean): SystemEvent {
  return createEvent(
    online ? 'device.online' : 'device.offline',
    { type: 'device', id: DEVICE_ID },
    { deviceId: DEVICE_ID, providerId: 'hikvision' },
  )
}

/** Process A accepts an offline, persists it, and is killed before its hold-off matures. */
async function offlineThenKilled(world: InMemoryRecords): Promise<void> {
  const first = await startCenter(world)
  await createLivenessRule(first)
  first.onSystemEvent(liveness(false))
  await vi.waitFor(() => {
    expect(ncTable(world, 'liveness')?.get(`device:${DEVICE_ID}`)).toMatchObject({
      state: 'offline',
    })
  })
  await vi.advanceTimersByTimeAsync(40_000)
  await first.stop()
  expect(ncTable(world, 'outbox')?.size ?? 0).toBe(0)
}

describe('liveness hold-off across a runner respawn', () => {
  it('THE INCIDENT: an offline the dead process never notified does not turn the bounce into a recovery', async () => {
    vi.useFakeTimers()
    const world = makeNcRecords()
    await offlineThenKilled(world)

    const second = await startCenter(world)
    await vi.advanceTimersByTimeAsync(30_000)
    second.onSystemEvent(liveness(true))
    await vi.advanceTimersByTimeAsync(6 * 60_000)

    expect(ncTable(world, 'outbox')?.size ?? 0).toBe(0)
  })

  it('an offline OLDER than the hold-off still gets its recovery', async () => {
    vi.useFakeTimers()
    const world = makeNcRecords()
    await offlineThenKilled(world)
    // The outage outlives the hold-off while no process is listening.
    await vi.advanceTimersByTimeAsync(DEVICE_LIVENESS_HOLDOFF_MS)

    const second = await startCenter(world)
    second.onSystemEvent(liveness(true))
    await vi.advanceTimersByTimeAsync(6 * 60_000)

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    const row = [...(ncTable(world, 'outbox')?.values() ?? [])][0]
    expect(row?.['deviceId']).toBe(DEVICE_ID)
  })
})
