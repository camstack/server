import { createEvent, NcRuleInputSchema } from '@camstack/types'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { resolvePruneWindows } from '../prune-windows.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

/**
 * D723: when the HUB restarts for an update, the centre runs on the hub and has
 * the grace to send "updating". A send that did not finish drains after the
 * reboot — next to "updated". A `node-updating` whose update has already
 * LANDED (a `server-updated` heard for the same node and version) is dropped.
 */
describe('a node-updating that drains after its landing is not sent', () => {
  const centers: NotificationCenter[] = []

  afterEach(async () => {
    await Promise.all(centers.map((center) => center.stop()))
  })

  async function harness() {
    const world = makeNcRecords()
    const sent: string[] = []
    const targets: NcTargetRef[] = [
      { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
    ]
    const center = new NotificationCenter({
      deviceSettings: makeFakeDeviceSettings(),
      records: world.records,
      logger: makeSilentLogger(),
      dispatcher: {
        listTargets: async () => targets,
        send: async () => {
          sent.push('send')
          return { success: true }
        },
        getMediaForOwner: async () => [],
        getDeviceName: async () => null,
      },
      listObjectEventsSince: async () => [],
      listRecentTracks: async () => [],
      listDeviceIdentities: async () => [],
      pruneWindows: async () => resolvePruneWindows({}),
      // Never on a timer: the test decides when the row drains.
      drainIntervalMs: 3_600_000,
      ruleReloadIntervalMs: 3_600_000,
    })
    centers.push(center)
    await center.start({ evaluation: true })
    await center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Updates',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['node-updating', 'node-restarting'] } },
        targets: [{ targetId: 'target-1' }],
        media: { attach: 'none' },
        throttle: { cooldownSec: 0, scope: 'rule' },
      }),
    })
    const outboxStatuses = (): readonly unknown[] =>
      [...(ncTable(world, 'outbox')?.values() ?? [])].map((row) => row['status'])
    return { center, sent, outboxStatuses }
  }

  function announce(center: NotificationCenter, toVersion: string): void {
    center.onSystemEvent(
      createEvent(
        'system.restarting',
        { type: 'core', id: 'addon-package-service' },
        {
          kind: 'framework-update',
          requestedAt: 1,
          packageName: '@camstack/server',
          fromVersion: '1.2.499',
          toVersion,
          nodeId: 'hub',
        },
      ),
    )
  }

  function land(center: NotificationCenter, toVersion: string): void {
    center.onSystemEvent(
      createEvent(
        'system.restart-completed',
        { type: 'core', id: 'system' },
        {
          kind: 'framework-update',
          requestedAt: 1,
          packageName: '@camstack/server',
          fromVersion: '1.2.499',
          toVersion,
          nodeId: 'hub',
        },
      ),
    )
  }

  it('drops it when the same node and version already landed', async () => {
    const { center, sent, outboxStatuses } = await harness()
    announce(center, '1.2.500')
    await vi.waitFor(() => expect(outboxStatuses()).toEqual(['pending']))
    land(center, '1.2.500')
    await center.drainNow()
    expect(sent).toEqual([])
    // Finished benignly, like a snooze — never a dead-letter.
    expect(outboxStatuses()).toEqual(['sent'])
  })

  it('sends it when nothing landed yet (the control)', async () => {
    const { center, sent, outboxStatuses } = await harness()
    announce(center, '1.2.500')
    await vi.waitFor(() => expect(outboxStatuses()).toEqual(['pending']))
    await center.drainNow()
    expect(sent).toEqual(['send'])
  })

  it('sends it when a DIFFERENT version landed', async () => {
    const { center, sent, outboxStatuses } = await harness()
    announce(center, '1.2.500')
    await vi.waitFor(() => expect(outboxStatuses()).toEqual(['pending']))
    land(center, '1.2.499')
    await center.drainNow()
    expect(sent).toEqual(['send'])
  })

  it('never supersedes a plain restart', async () => {
    const { center, sent, outboxStatuses } = await harness()
    center.onSystemEvent(
      createEvent(
        'system.restarting',
        { type: 'core', id: 'addon-package-service' },
        { kind: 'manual', requestedAt: 1, nodeId: 'hub' },
      ),
    )
    await vi.waitFor(() => expect(outboxStatuses()).toEqual(['pending']))
    land(center, '1.2.500')
    await center.drainNow()
    expect(sent).toEqual(['send'])
  })
})
