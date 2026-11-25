/**
 * A COLD DIRECTORY MUST NOT SEND A BLIND OFFLINE (planning#726). The centre
 * restarted, replayed offline for accessories before its directory knew them,
 * and "35 devices offline" was sent at +90 s.
 */
import type { InMemoryRecords } from '@camstack/types'
import { createEvent, DeviceType, NcRuleInputSchema, type SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcDeviceIdentity } from '../device-directory.js'
import { NotificationCenter } from '../index.js'
import { DEVICE_LIVENESS_HOLDOFF_MS } from '../liveness-holdoff.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { makeNcRecords, ncPruneWindowsPort, ncTable } from './support/nc-test-deps.js'

const ACCESSORY = 6001
const FIRST_LEVEL = 6002
const WINDOW = DEVICE_LIVENESS_HOLDOFF_MS

const TARGETS = [
  { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
] as const

const centers: NotificationCenter[] = []

afterEach(async () => {
  await Promise.all(centers.map((center) => center.stop()))
  centers.length = 0
  vi.useRealTimers()
})

interface ColdDirectory {
  readonly center: NotificationCenter
  readonly world: InMemoryRecords
  /** Answers the directory's first read: the hub's device manager is up. */
  warm(): void
}

/** A centre whose device directory has NOT answered its first read yet. */
async function startColdCenter(): Promise<ColdDirectory> {
  const world = makeNcRecords()
  let answer: (devices: readonly NcDeviceIdentity[]) => void = () => undefined
  const firstRead = new Promise<readonly NcDeviceIdentity[]>((resolve) => {
    answer = resolve
  })
  const devices: readonly NcDeviceIdentity[] = [
    {
      deviceId: ACCESSORY,
      type: DeviceType.Sensor,
      name: 'Accessory',
      isCamera: false,
      online: false,
      parentDeviceId: 6000,
    },
    {
      deviceId: FIRST_LEVEL,
      type: DeviceType.Sensor,
      name: 'First level',
      isCamera: false,
      online: false,
      parentDeviceId: null,
    },
  ]
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
    listDeviceIdentities: () => firstRead,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  void center.start({ evaluation: true })
  await vi.advanceTimersByTimeAsync(10)
  await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Liveness',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['device-online', 'device-offline'] } },
      targets: [{ targetId: 'target-1' }],
      media: { attach: 'none' },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
    }),
  })
  return { center, world, warm: () => answer(devices) }
}

function liveness(deviceId: number, online: boolean): SystemEvent {
  return createEvent(
    online ? 'device.online' : 'device.offline',
    { type: 'device', id: deviceId },
    { deviceId, providerId: 'provider-unifi' },
  )
}

function outbox(world: InMemoryRecords): number {
  return ncTable(world, 'outbox').size
}

describe('an offline from a cold directory is judged once it warms (planning#726)', () => {
  it('THE INCIDENT: cold offline, directory places an accessory, its drop, 90 s: nothing is sent', async () => {
    vi.useFakeTimers()
    const { center, world, warm } = await startColdCenter()
    center.onSystemEvent(liveness(ACCESSORY, true))
    center.onSystemEvent(liveness(ACCESSORY, false))
    warm()
    await vi.advanceTimersByTimeAsync(1_000)
    // the recovery arrives from the now-warm directory: dropped as an accessory
    center.onSystemEvent(liveness(ACCESSORY, true))
    await vi.advanceTimersByTimeAsync(WINDOW * 2)
    expect(outbox(world)).toBe(0)
  })

  it('control: a real first-level device offline from a cold directory still fires after 90 s', async () => {
    vi.useFakeTimers()
    const { center, world, warm } = await startColdCenter()
    center.onSystemEvent(liveness(FIRST_LEVEL, true))
    center.onSystemEvent(liveness(FIRST_LEVEL, false))
    warm()
    await vi.advanceTimersByTimeAsync(WINDOW - 5_000)
    expect(outbox(world)).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => {
      expect(outbox(world)).toBeGreaterThan(0)
    })
  })
})
