/** D62 — the operator's switch outranks liveness on the instant path. */
import type { InMemoryRecords } from '@camstack/types'
import { createEvent, DeviceType, NcRuleInputSchema, type SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcDeviceIdentity } from '../device-directory.js'
import { ncPruneWindowsPort, makeNcRecords, ncTable } from './support/nc-test-deps.js'
import type { NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CAMERA_IDS = Array.from({ length: 15 }, (_, i) => 600 + i)

const TARGETS: readonly NcTargetRef[] = [
  {
    id: 'target-1',
    addonId: 'notifiers',
    name: 'phone',
    kind: 'ntfy',
    enabled: true,
  },
]

const centers: NotificationCenter[] = []

afterEach(async () => {
  await Promise.all(centers.map((center) => center.stop()))
  centers.length = 0
})

/** One directory entry. `online` absent = this hub did not supply liveness. */
function identity(deviceId: number, online?: boolean): NcDeviceIdentity {
  return {
    deviceId,
    type: DeviceType.Camera,
    name: `Camera ${deviceId}`,
    isCamera: true,
    ...(online !== undefined ? { online } : {}),
  }
}

/**
 * A centre wired over `store`, started as the evaluating node.
 *
 * `identities` defaults to a directory that carries NO liveness at all — the
 * older wiring, and the shape every test above the directory-seed block was
 * written against.
 */
async function startCenter(
  world: InMemoryRecords,
  identities: readonly NcDeviceIdentity[] = CAMERA_IDS.map((deviceId) => identity(deviceId)),
): Promise<NotificationCenter> {
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: ncPruneWindowsPort(),
    dispatcher: {
      listTargets: async () => [...TARGETS],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Camera',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => identities,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: true })
  // The ledger reseed + the directory seed are BACK-FILL phases now (`start()`
  // resolving means the intake is open, not that the ledger has been
  // recovered). THIS suite is about the reseed, so it waits for it. A cold
  // ledger in the live window still fails toward DISCARD — it seeds silently
  // rather than notifying — which is the direction D130 requires.
  await center.whenHydrated()
  return center
}

/** The operator's rule: tell me when a camera goes down or comes back. */
async function createLivenessRule(center: NotificationCenter): Promise<void> {
  await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Camera liveness',
      delivery: 'system-event',
      conditions: {
        systemEvent: { kinds: ['device-online', 'device-offline'] },
      },
      targets: [{ targetId: 'target-1' }],
      media: { attach: 'none' },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
    }),
  })
}

function liveness(deviceId: number, online: boolean): SystemEvent {
  return createEvent(
    online ? 'device.online' : 'device.offline',
    { type: 'device', id: deviceId },
    { deviceId, providerId: 'reolink' },
  )
}

function switchEvent(deviceId: number, disabled: boolean): SystemEvent {
  return createEvent(
    disabled ? 'device.disabled' : 'device.enabled',
    { type: 'device', id: deviceId },
    { deviceId },
  )
}

function streamOffline(deviceId: number): SystemEvent {
  return createEvent(
    'stream.offline',
    { type: 'stream-broker', id: `${deviceId}/native:main` },
    {
      deviceId,
      camStreamId: 'native:main',
      profile: 'high',
      reason: 'stale-timeout',
    },
  )
}

function kinds(world: InMemoryRecords): readonly unknown[] {
  return [...(ncTable(world, 'outbox')?.values() ?? [])].map((row) => {
    const payload = row['payload']
    if (payload === null || typeof payload !== 'object') return undefined
    const subject = (payload as Record<string, unknown>)['subject']
    if (subject === null || typeof subject !== 'object') return undefined
    const sys = (subject as Record<string, unknown>)['systemEvent']
    if (sys === null || typeof sys !== 'object') return undefined
    return `${(sys as Record<string, unknown>)['kind']}:${(sys as Record<string, unknown>)['deviceId']}`
  })
}

describe('D62 — a switched-off device never notifies as offline', () => {
  it('device-offline and stream-offline of a disabled device are dropped; an enabled one still notifies', async () => {
    const world = makeNcRecords()
    const center = await startCenter(world)
    await center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Outages',
        delivery: 'system-event',
        conditions: {
          systemEvent: { kinds: ['device-offline', 'stream-offline'] },
        },
        targets: [{ targetId: 'target-1' }],
        media: { attach: 'none' },
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })
    center.onSystemEvent(liveness(600, true)) // seed
    center.onSystemEvent(liveness(601, true)) // seed
    center.onSystemEvent(switchEvent(600, true))
    center.onSystemEvent(liveness(600, false))
    center.onSystemEvent(streamOffline(600))
    // CONTROL: an enabled device really going away notifies.
    center.onSystemEvent(liveness(601, false))
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    expect(kinds(world)).toEqual(['device-offline:601'])
  })
})
