/**
 * D905 through the REAL centre: the reload tick announces a rule that cannot
 * work on the bus — once, however many ticks run — and an unanswered device
 * read announces nothing.
 */
import type { InMemoryRecords, SystemEvent } from '@camstack/types'
import { EventCategory, NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NcDeviceIdentity } from '../device-directory.js'
import { NotificationCenter } from '../index.js'
import { makeRecordingLogger } from './device-prune-harness.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { makeNcRecords } from './support/nc-test-deps.js'

const CALLER = { userId: 'admin-42', isAdmin: true }
const DEAD = 4483

function identity(deviceId: number): NcDeviceIdentity {
  return { deviceId, type: 'camera', name: `cam ${deviceId}`, isCamera: true }
}

interface Harness {
  readonly center: NotificationCenter
  readonly emitted: SystemEvent[]
  readonly world: InMemoryRecords
}

function makeCenter(deleted: (deviceId: number) => Promise<boolean>): Harness {
  const world = makeNcRecords()
  const emitted: SystemEvent[] = []
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeRecordingLogger().logger,
    pruneWindows: async () => ({
      outboxMs: null,
      timelapseExportMs: null,
      artifactShelfMs: null,
      summaryMosaicMs: null,
    }),
    listUsers: async () => [],
    getDeviceRoute: async () => null,
    dispatcher: {
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
      ],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Robot',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    // The re-created robot answers under a new id; the old one is gone.
    listDeviceIdentities: async () => [identity(4700)],
    isDeviceDeleted: deleted,
    emitBusEvent: (event) => emitted.push(event),
    now: () => 100_000,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 5,
  })
  return { center, emitted, world }
}

const broken = (h: Harness): SystemEvent[] =>
  h.emitted.filter((e) => e.category === EventCategory.NotificationRuleBroken)

describe('D905 — rule health through the centre', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('a rule whose only device was deleted is announced broken ONCE across many ticks', async () => {
    h = makeCenter(async (id) => id === DEAD)
    await h.center.start({ evaluation: true })
    const { rule } = await h.center.buildProvider().createRule({
      rule: NcRuleInputSchema.parse({
        name: 'Robot',
        delivery: 'immediate',
        targets: [{ targetId: 'tgt-1' }],
        conditions: { devices: [DEAD] },
      }),
      caller: CALLER,
    })
    await vi.waitFor(() => expect(broken(h)).toHaveLength(1), { timeout: 2_000, interval: 10 })
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(broken(h)).toHaveLength(1)
    expect(broken(h)[0]?.data).toMatchObject({
      ruleId: rule.id,
      ruleName: 'Robot',
      reason: 'device-deleted',
      offendingIds: [String(DEAD)],
    })
  })

  it('a device read that does not answer announces nothing', async () => {
    h = makeCenter(async () => {
      throw new Error('device manager unavailable')
    })
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({
      rule: NcRuleInputSchema.parse({
        name: 'Robot',
        delivery: 'immediate',
        targets: [{ targetId: 'tgt-1' }],
        conditions: { devices: [DEAD] },
      }),
      caller: CALLER,
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(broken(h)).toEqual([])
  })

  it('a stored row that does not load is announced broken ONCE', async () => {
    h = makeCenter(async () => false)
    h.world.seed('rules', {
      id: 'r-zero',
      data: {
        name: 'Eventi di sistema — dispositivi',
        enabled: true,
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['stream-offline'] } },
        targets: [{ targetId: 'tgt-1' }],
        createdBy: 'admin',
        createdAt: 1,
        updatedAt: 1,
        disabledTargetIds: [],
        priority: 'urgent',
      },
    })
    await h.center.start({ evaluation: true })
    await vi.waitFor(() => expect(broken(h)).toHaveLength(1), { timeout: 2_000, interval: 10 })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(broken(h)).toHaveLength(1)
    expect(broken(h)[0]?.data).toMatchObject({ ruleId: 'r-zero', reason: 'unparseable' })
  })
})
