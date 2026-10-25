/**
 * The alert centre sends nothing of its own: an alert reaches the operator ONLY
 * through a system-event rule on `alert-critical` / `alert-error` /
 * `alert-critical-resolved`, once per alert EPISODE.
 *
 *  - a critical alert announced on the bus is notified once;
 *  - a re-emit of the same open alert never notifies again;
 *  - its resolution notifies `alert-critical-resolved`;
 *  - a boot reconcile from the alerts store notifies an open critical alert
 *    whose announcement was never heard, once — and not again after a restart;
 *  - the reconcile never reads an unread ledger as "nothing was notified".
 */
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import {
  alertEpisodePayload,
  EventCategory,
  NcRuleInputSchema,
  type Alert,
  type NcSystemEventKind,
  type SystemEvent,
} from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const TARGETS: NcTargetRef[] = [
  {
    id: 'target-1',
    addonId: 'notifiers',
    name: 'phone',
    kind: 'ntfy',
    enabled: true,
  },
]
const NOW = Date.UTC(2026, 9, 21, 6, 0)

const alertOf = (over: Partial<Alert> = {}): Alert => ({
  id: 'recorder:placement:loc-1',
  category: 'recorder.placement',
  severity: 'critical',
  title: 'Recording location full',
  message: 'No free space on loc-1',
  status: 'active',
  read: false,
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
  source: { type: 'addon', id: 'recorder' },
  action: { label: 'Open', href: '/system/storage' },
  metadata: { episodeId: 'recorder:placement:loc-1@1' },
  ...over,
})

function episodeEvent(alert: Alert, phase: 'raised' | 'resolved'): SystemEvent {
  return {
    id: `ep-${phase}-${String(Math.random())}`,
    timestamp: new Date(NOW),
    source: { type: 'addon', id: 'alert-center', nodeId: 'hub' },
    category: EventCategory.AlertEpisode,
    data: { ...alertEpisodePayload(alert, phase, NOW) },
  }
}

describe('alert episodes reach the operator only through a system-event rule', () => {
  const centers: NotificationCenter[] = []
  afterEach(async () => {
    await Promise.all(centers.map((c) => c.stop()))
    centers.length = 0
  })

  async function boot(
    world: InMemoryRecords,
    opts: {
      readAlerts?: () => Promise<readonly Alert[]>
      kinds?: readonly NcSystemEventKind[]
      createRule?: boolean
    } = {},
  ) {
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
      now: () => NOW,
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
      readRunnerStates: {
        coreBlocks: async () => [],
        nodeAddons: async () => [],
      },
      ...(opts.readAlerts !== undefined ? { readAlerts: opts.readAlerts } : {}),
      drainIntervalMs: 3_600_000,
      ruleReloadIntervalMs: 3_600_000,
      alertReconcileIntervalMs: 3_600_000,
    })
    centers.push(center)
    await center.start({ evaluation: true })
    await center.whenHydrated()
    if (opts.createRule !== false) {
      await center.buildProvider().createRule({
        caller: { userId: 'admin', isAdmin: true },
        rule: NcRuleInputSchema.parse({
          name: 'Alert',
          delivery: 'system-event',
          conditions: {
            systemEvent: {
              kinds: opts.kinds ?? ['alert-critical', 'alert-critical-resolved'],
            },
          },
          systemEventDelivery: { mode: 'instant' },
          targets: [{ targetId: 'target-1' }],
          throttle: { cooldownSec: 0, scope: 'rule-device' },
        }),
      })
    }
    return center
  }

  /** The rule exists BEFORE the centre under test boots, as it does on a real hub. */
  async function seedRule(world: InMemoryRecords): Promise<void> {
    await boot(world)
    await Promise.all(centers.map((c) => c.stop()))
    centers.length = 0
  }

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60))
  const rows = (world: InMemoryRecords): number => ncTable(world, 'outbox')?.size ?? 0

  it('a critical alert announced once enqueues exactly one notification', async () => {
    const world = makeNcRecords()
    const center = await boot(world)
    center.onSystemEvent(episodeEvent(alertOf(), 'raised'))
    await settle()
    expect(rows(world)).toBe(1)
    const row = [...(ncTable(world, 'outbox')?.values() ?? [])][0]
    expect(JSON.stringify(row)).toContain('alert-critical')
  })

  it('a re-emit of the same open alert never notifies again', async () => {
    const world = makeNcRecords()
    const center = await boot(world)
    const alert = alertOf()
    center.onSystemEvent(episodeEvent(alert, 'raised'))
    center.onSystemEvent(episodeEvent(alert, 'raised'))
    center.onSystemEvent(episodeEvent({ ...alert, message: 'No free space (98%)' }, 'raised'))
    await settle()
    expect(rows(world)).toBe(1)
  })

  it('its resolution notifies once as alert-critical-resolved; a new episode notifies again', async () => {
    const world = makeNcRecords()
    const center = await boot(world)
    const alert = alertOf()
    center.onSystemEvent(episodeEvent(alert, 'raised'))
    center.onSystemEvent(episodeEvent({ ...alert, status: 'dismissed' }, 'resolved'))
    center.onSystemEvent(episodeEvent({ ...alert, status: 'dismissed' }, 'resolved'))
    await settle()
    expect(rows(world)).toBe(2)
    center.onSystemEvent(
      episodeEvent(alertOf({ metadata: { episodeId: 'recorder:placement:loc-1@2' } }), 'raised'),
    )
    await settle()
    expect(rows(world)).toBe(3)
  })

  it('D911: a device-sourced critical alert notifies ONCE, in the devices family, never also as alert-critical', async () => {
    const world = makeNcRecords()
    const center = await boot(world, {
      kinds: ['device-attention-required', 'device-attention-resolved'],
    })
    // A second rule, in the system family, listening for the generic alert kinds.
    await center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Generic alerts',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['alert-critical', 'alert-critical-resolved'] } },
        systemEventDelivery: { mode: 'instant' },
        targets: [{ targetId: 'target-1' }],
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })
    const alert = alertOf({
      id: 'dreame.pin-required:42',
      category: 'device.credentials-required',
      source: { type: 'device', id: '42' },
      metadata: { episodeId: 'dreame.pin-required:42@1' },
    })
    center.onSystemEvent(episodeEvent(alert, 'raised'))
    center.onSystemEvent(episodeEvent(alert, 'raised'))
    await settle()
    expect(rows(world)).toBe(1)
    const row = JSON.stringify([...(ncTable(world, 'outbox')?.values() ?? [])][0])
    expect(row).toContain('device-attention-required')
    center.onSystemEvent(episodeEvent({ ...alert, status: 'completed' }, 'resolved'))
    await settle()
    expect(rows(world)).toBe(2)
  })

  it('a rule that did not opt into the kind is not notified (error needs alert-error)', async () => {
    const world = makeNcRecords()
    const center = await boot(world)
    center.onSystemEvent(episodeEvent(alertOf({ severity: 'error' }), 'raised'))
    center.onSystemEvent(episodeEvent(alertOf({ severity: 'warning', id: 'w' }), 'raised'))
    await settle()
    expect(rows(world)).toBe(0)
  })

  it('a resolution for an episode this centre never notified says nothing', async () => {
    const world = makeNcRecords()
    const center = await boot(world)
    center.onSystemEvent(episodeEvent(alertOf({ status: 'completed' }), 'resolved'))
    await settle()
    expect(rows(world)).toBe(0)
  })

  it('boot reconcile notifies an open critical alert whose announcement was never heard, once, across a restart', async () => {
    const world = makeNcRecords()
    const alerts: Alert[] = [
      alertOf(),
      alertOf({
        id: 'quiet',
        severity: 'warning',
        metadata: { episodeId: 'quiet@1' },
      }),
    ]
    const readAlerts = async (): Promise<readonly Alert[]> => alerts
    await seedRule(world)
    await boot(world, { readAlerts, createRule: false })
    await settle()
    expect(rows(world)).toBe(1)

    // a restart of the centre over the SAME durable state: nothing new is sent
    await Promise.all(centers.map((c) => c.stop()))
    centers.length = 0
    const restarted = await boot(world, { readAlerts, createRule: false })
    await settle()
    expect(rows(world)).toBe(1)
    restarted.onSystemEvent(episodeEvent(alerts[0] as Alert, 'raised'))
    await settle()
    expect(rows(world)).toBe(1)
  })

  it('boot reconcile finds a notified episode closed while the centre was down and notifies the resolution once', async () => {
    const world = makeNcRecords()
    const alert = alertOf()
    let current: readonly Alert[] = [alert]
    const readAlerts = async (): Promise<readonly Alert[]> => current
    await seedRule(world)
    await boot(world, { readAlerts, createRule: false })
    await settle()
    expect(rows(world)).toBe(1)

    await Promise.all(centers.map((c) => c.stop()))
    centers.length = 0
    current = [{ ...alert, status: 'dismissed' }]
    await boot(world, { readAlerts, createRule: false })
    await settle()
    expect(rows(world)).toBe(2)
  })

  it('an alerts read that fails changes nothing and is retried by the next reconcile', async () => {
    const world = makeNcRecords()
    let up = false
    const readAlerts = async (): Promise<readonly Alert[]> => {
      if (!up) throw new Error('alerts provider not available')
      return [alertOf()]
    }
    await seedRule(world)
    await boot(world, { readAlerts, createRule: false })
    await settle()
    expect(rows(world)).toBe(0)
    up = true
    await centers[0]?.reconcileAlertEpisodes()
    await settle()
    expect(rows(world)).toBe(1)
  })
})
