import { createEvent, DeviceType, NcRuleInputSchema, type SystemEvent } from '@camstack/types'
import type { InMemoryRecords } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NotificationCenter } from '../index.js'
import { ncPruneWindowsPort, makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { STREAM_LIVENESS_HOLDOFF_MS } from '../liveness-holdoff.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

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
    streamLivenessHoldoffMs: STREAM_LIVENESS_HOLDOFF_MS,
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
  return center
}

function stream(online: boolean): SystemEvent {
  return createEvent(
    online ? 'stream.online' : 'stream.offline',
    { type: 'device', id: 108 },
    {
      deviceId: 108,
      profile: 'high',
      brokerId: 'broker-108',
      sourceType: 'rtsp',
      lastPacketAt: 0,
      reason: online ? 'recovered' : 'stale-timeout',
    },
  )
}

async function withStreamRule(world: InMemoryRecords): Promise<NotificationCenter> {
  const center = await startCenter(world)
  await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Stream liveness',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['stream-online', 'stream-offline'] } },
      targets: [{ targetId: 'target-1' }],
      media: { attach: 'none' },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
    }),
  })
  return center
}

describe('stream liveness hold-off, wired', () => {
  it('a stream that drops and returns inside the window notifies nothing', async () => {
    vi.useFakeTimers()
    const world = makeNcRecords()
    const center = await withStreamRule(world)
    center.onSystemEvent(stream(false))
    await vi.advanceTimersByTimeAsync(STREAM_LIVENESS_HOLDOFF_MS / 2)
    center.onSystemEvent(stream(true))
    await vi.advanceTimersByTimeAsync(STREAM_LIVENESS_HOLDOFF_MS)
    expect(ncTable(world, 'outbox')?.size ?? 0).toBe(0)
  })

  it('a stream outage that lasts the window IS announced', async () => {
    vi.useFakeTimers()
    const world = makeNcRecords()
    const center = await withStreamRule(world)
    center.onSystemEvent(stream(false))
    await vi.advanceTimersByTimeAsync(STREAM_LIVENESS_HOLDOFF_MS)
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
  })
})
