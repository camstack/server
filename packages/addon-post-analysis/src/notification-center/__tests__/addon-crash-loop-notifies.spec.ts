/**
 * The alert centre pushes nothing of its own (operator decision 2026-10-21), so
 * `addon-crash-loop` is an ordinary system event: an instant rule on it
 * enqueues one notification, and the state-summary row of the crash loop is
 * recorded exactly as before.
 */
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { NcRuleInputSchema, scheduleForSendTimes } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const TARGETS: NcTargetRef[] = [
  { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
]
const NOON = scheduleForSendTimes([{ days: [0, 1, 2, 3, 4, 5, 6], minute: 12 * 60 }], 'UTC')

describe('addon-crash-loop is an ordinary system event', () => {
  const centers: NotificationCenter[] = []
  afterEach(async () => {
    await Promise.all(centers.map((c) => c.stop()))
    centers.length = 0
  })

  it('an INSTANT rule on it enqueues one notification, and the summary still lists the runner', async () => {
    const world = makeNcRecords()
    const center = new NotificationCenter({
      deviceSettings: makeFakeDeviceSettings(),
      records: world.records,
      logger: makeSilentLogger(),
      pruneWindows: async () => ({
        outboxMs: null,
        timelapseExportMs: null,
        artifactShelfMs: null,
        summaryMosaicMs: null,
      }),
      now: () => Date.UTC(2026, 9, 4, 6, 21),
      dispatcher: {
        listTargets: async () => TARGETS,
        send: async () => ({ success: true }),
        getMediaForOwner: async () => [],
        getDeviceName: async () => 'x',
      },
      listObjectEventsSince: async () => [],
      listRecentTracks: async () => [],
      listDeviceIdentities: async () => [],
      readNodeDirectory: async () => ({
        nodes: [{ id: 'hub', name: 'hub', isHub: true, isOnline: true }],
        complete: true,
      }),
      readRunnerStates: { coreBlocks: async () => [], nodeAddons: async () => [] },
      drainIntervalMs: 3_600_000,
      ruleReloadIntervalMs: 3_600_000,
    })
    centers.push(center)
    await center.start({ evaluation: true })
    await center.whenHydrated()
    const provider = center.buildProvider()
    const caller = { userId: 'admin', isAdmin: true }
    await provider.createRule({
      caller,
      rule: NcRuleInputSchema.parse({
        name: 'Crash subito',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['addon-crash-loop'] } },
        systemEventDelivery: { mode: 'instant' },
        targets: [{ targetId: 'target-1' }],
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })
    const summaryRule = NcRuleInputSchema.parse({
      name: 'Sistema',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['addon-crash-loop'] } },
      systemEventDelivery: { mode: 'summary', schedule: NOON, split: 'section' },
      targets: [{ targetId: 'target-1' }],
    })
    center.onSystemEvent({
      id: 'runner-failed-recorder',
      timestamp: new Date(Date.UTC(2026, 9, 4, 6, 21)),
      source: { type: 'core', id: 'recorder', nodeId: 'hub' },
      category: 'addon.runner-failed',
      data: {
        runnerId: 'recorder',
        nodeId: 'hub',
        addonIds: ['recorder'],
        crashesInWindow: 5,
        windowMs: 60_000,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(ncTable(world, 'outbox')?.size ?? 0).toBe(1)
    const preview = await provider.previewStateSummary({ rule: summaryRule })
    expect(preview.count).toBe(1)
  })
})
