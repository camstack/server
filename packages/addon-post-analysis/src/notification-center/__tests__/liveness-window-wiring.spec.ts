import { createEvent, DeviceType, NcRuleInputSchema, type SystemEvent } from '@dominevo/types'
import type { InMemoryRecords } from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NotificationCenter } from '../index.js'
import { ncPruneWindowsPort, makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const TARGETS = [
  { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
] as const
const WINDOW_MS = 90_000

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
    livenessHoldoffMs: WINDOW_MS,
    streamLivenessHoldoffMs: WINDOW_MS,
    dispatcher: {
      listTargets: async () => [...TARGETS],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Camera',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [
      { deviceId: 108, type: DeviceType.Camera, name: 'Camera 108', isCamera: true, online: true },
    ],
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: true })
  await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Liveness',
      delivery: 'system-event',
      conditions: {
        systemEvent: {
          kinds: ['device-online', 'device-offline', 'stream-online', 'stream-offline'],
        },
      },
      targets: [{ targetId: 'target-1' }],
      media: { attach: 'none' },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
    }),
  })
  return center
}

function deviceOffline(): SystemEvent {
  return createEvent(
    'device.offline',
    { type: 'device', id: 108 },
    { deviceId: 108, providerId: 'hikvision' },
  )
}

function streamOffline(): SystemEvent {
  return createEvent(
    'stream.offline',
    { type: 'device', id: 108 },
    {
      deviceId: 108,
      profile: 'high',
      brokerId: 'broker-108',
      sourceType: 'rtsp',
      lastPacketAt: 0,
      reason: 'stale-timeout',
    },
  )
}

describe('liveness hold-offs, wired into removal and stop (planning#714)', () => {
  it('removing a device cancels its pending offline', async () => {
    vi.useFakeTimers()
    const world = makeNcRecords()
    const center = await startCenter(world)
    center.onSystemEvent(deviceOffline())
    await center.removeDeviceData(108)
    await vi.advanceTimersByTimeAsync(WINDOW_MS * 2)
    expect(ncTable(world, 'outbox')?.size ?? 0).toBe(0)
  })

  it('removing a device cancels its pending stream offline', async () => {
    vi.useFakeTimers()
    const world = makeNcRecords()
    const center = await startCenter(world)
    center.onSystemEvent(streamOffline())
    await center.removeDeviceData(108)
    await vi.advanceTimersByTimeAsync(WINDOW_MS * 2)
    expect(ncTable(world, 'outbox')?.size ?? 0).toBe(0)
  })

  it('stop() disposes the stream hold-off', async () => {
    vi.useFakeTimers()
    const world = makeNcRecords()
    const center = await startCenter(world)
    center.onSystemEvent(streamOffline())
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await center.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('control: an untouched device offline IS announced after the window', async () => {
    vi.useFakeTimers()
    const world = makeNcRecords()
    const center = await startCenter(world)
    center.onSystemEvent(deviceOffline())
    await vi.advanceTimersByTimeAsync(WINDOW_MS)
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
  })
})
