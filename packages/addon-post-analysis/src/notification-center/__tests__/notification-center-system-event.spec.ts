import { createEvent, DeviceType, NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcTargetRef } from '../dispatcher.js'
import { ncPruneWindowsPort, makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

describe('NotificationCenter system-event outbox', () => {
  const centers: NotificationCenter[] = []

  afterEach(async () => {
    await Promise.all(centers.map((center) => center.stop()))
  })

  it('matches a camera-typed device-offline rule and freezes normalized data', async () => {
    const world = makeNcRecords()
    const targets: NcTargetRef[] = [
      { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
    ]
    const center = new NotificationCenter({
      deviceSettings: makeFakeDeviceSettings(),
      records: world.records,
      logger: makeSilentLogger(),
      pruneWindows: ncPruneWindowsPort(),
      dispatcher: {
        listTargets: async () => targets,
        send: async () => ({ success: true }),
        getMediaForOwner: async () => [],
        getDeviceName: async () => 'Driveway',
      },
      listObjectEventsSince: async () => [],
      listRecentTracks: async () => [],
      // 104 IS a camera, and the wiring has to say so: the subject carries the
      // device type, and a `deviceTypes` rule fails closed on an id the mirror
      // cannot place (`system-event-device-kind.spec.ts`).
      listDeviceIdentities: async () => [
        { deviceId: 104, type: DeviceType.Camera, name: 'Driveway', isCamera: true },
      ],
      drainIntervalMs: 3_600_000,
      ruleReloadIntervalMs: 3_600_000,
    })
    centers.push(center)
    await center.start({ evaluation: true })
    await center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Camera offline',
        delivery: 'system-event',
        // The MIGRATED shape: a generic kind, narrowed to cameras by the rule.
        conditions: {
          systemEvent: { kinds: ['device-offline'], deviceTypes: ['camera'], deviceIds: [104] },
        },
        targets: [{ targetId: 'target-1' }],
        media: { attach: 'best' },
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })

    // The camera must be OBSERVED before it can be seen to change: the
    // liveness ledger seeds a subject's first observation silently, so a
    // notification is only ever a claim about two observations
    // (`system-liveness-seed.spec.ts`). This is that first one — it notifies
    // nothing, which is exactly why the assertion below is `1` and not `2`.
    center.onSystemEvent(
      createEvent(
        'device.online',
        { type: 'device', id: 104 },
        { deviceId: 104, providerId: 'reolink' },
      ),
    )
    center.onSystemEvent(
      createEvent(
        'device.offline',
        { type: 'device', id: 104 },
        {
          deviceId: 104,
          providerId: 'reolink',
          reason: 'timeout',
        },
      ),
    )
    center.onSystemEvent({
      id: 'same-edge-from-runtime-state',
      timestamp: new Date(),
      source: { type: 'device', id: 104 },
      category: 'device.state-changed',
      data: {
        deviceId: 104,
        capName: 'device-status',
        slice: { online: false },
      },
    })

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    const row = [...(ncTable(world, 'outbox')?.values() ?? [])][0]
    expect(row?.['recordKind']).toBe('system-event')
    expect(row?.['deviceId']).toBe(104)
    expect(row?.['payload']).toMatchObject({
      delivery: 'system-event',
      media: 'none',
      subject: {
        systemEvent: {
          kind: 'device-offline',
          subject: 'device:104',
          data: { category: 'device.offline', reason: 'timeout' },
        },
      },
    })
  })

  it('freezes the NODE on the outbox row, which is what the tap URL reads', async () => {
    /*
     * `notificationRules.getHistory` does NOT project `nodeId` — it renders
     * `{kind, subject, title, body, data}` and nothing else — so an operator
     * reading a history row sees no node and reasonably concludes the intake
     * dropped it. It does not. This asserts the DURABLE row, which is the one
     * `system-event-tap-url.ts` reads at delivery, from a RAW bus event: the
     * dispatcher-side test starts from a hand-built subject that already
     * carries the field, and could never have caught the intake losing it.
     */
    const world = makeNcRecords()
    const targets: NcTargetRef[] = [
      { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
    ]
    const center = new NotificationCenter({
      deviceSettings: makeFakeDeviceSettings(),
      records: world.records,
      logger: makeSilentLogger(),
      pruneWindows: ncPruneWindowsPort(),
      dispatcher: {
        listTargets: async () => targets,
        send: async () => ({ success: true }),
        getMediaForOwner: async () => [],
        getDeviceName: async () => null,
      },
      listObjectEventsSince: async () => [],
      listRecentTracks: async () => [],
      listDeviceIdentities: async () => [],
      drainIntervalMs: 3_600_000,
      ruleReloadIntervalMs: 3_600_000,
    })
    centers.push(center)
    await center.start({ evaluation: true })
    await center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Aggiornamenti',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['addon-update-available'] } },
        targets: [{ targetId: 'target-1' }],
        media: { attach: 'none' },
        throttle: { cooldownSec: 0, scope: 'rule' },
      }),
    })

    center.onSystemEvent(
      createEvent(
        'update.available',
        { type: 'core', id: 'updates' },
        {
          target: 'addon',
          packageName: '@camstack/addon-terminal',
          currentVersion: '0.1.47',
          latestVersion: '0.1.51',
          nodeId: 'agent-a',
        },
      ),
    )

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    const row = [...(ncTable(world, 'outbox')?.values() ?? [])][0]
    expect(row?.['payload']).toMatchObject({
      subject: {
        systemEvent: { kind: 'addon-update-available', nodeId: 'agent-a' },
      },
    })
  })

  it('delivers an export to the picker targets even with no matching rule', async () => {
    const world = makeNcRecords()
    const targets: NcTargetRef[] = [
      { id: 'phone', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
      { id: 'telegram', addonId: 'notifiers', name: 'telegram', kind: 'telegram', enabled: true },
    ]
    const center = new NotificationCenter({
      deviceSettings: makeFakeDeviceSettings(),
      records: world.records,
      logger: makeSilentLogger(),
      pruneWindows: ncPruneWindowsPort(),
      dispatcher: {
        listTargets: async () => targets,
        send: async () => ({ success: true }),
        getMediaForOwner: async () => [],
        getDeviceName: async () => 'Hall',
      },
      listObjectEventsSince: async () => [],
      listRecentTracks: async () => [],
      listDeviceIdentities: async () => [
        { deviceId: 104, type: DeviceType.Camera, name: 'Hall', isCamera: true },
      ],
      drainIntervalMs: 3_600_000,
      ruleReloadIntervalMs: 3_600_000,
    })
    centers.push(center)
    await center.start({ evaluation: true })

    center.onSystemEvent(
      createEvent(
        'recording.export.completed',
        { type: 'addon', id: 'recorder' },
        {
          exportId: 'exp-picker',
          fileBytes: 4_000,
          deviceId: 104,
          title: 'Hall',
          notifyTargetIds: ['phone', 'telegram'],
        },
      ),
    )

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(2)
    })
    const rows = [...(ncTable(world, 'outbox')?.values() ?? [])]
    expect(rows.map((row) => row['ruleId']).toSorted()).toEqual([
      'nc-export-notify',
      'nc-export-notify',
    ])
    expect(rows.map((row) => row['targetId']).toSorted()).toEqual(['phone', 'telegram'])
    expect(rows[0]?.['payload']).toMatchObject({
      ruleName: 'export',
      delivery: 'system-event',
      subject: { systemEvent: { kind: 'export-completed' } },
    })
  })

  it('does not double-notify a picker target a matching rule already reached', async () => {
    const world = makeNcRecords()
    const targets: NcTargetRef[] = [
      { id: 'phone', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
      { id: 'telegram', addonId: 'notifiers', name: 'telegram', kind: 'telegram', enabled: true },
    ]
    const center = new NotificationCenter({
      deviceSettings: makeFakeDeviceSettings(),
      records: world.records,
      logger: makeSilentLogger(),
      pruneWindows: ncPruneWindowsPort(),
      dispatcher: {
        listTargets: async () => targets,
        send: async () => ({ success: true }),
        getMediaForOwner: async () => [],
        getDeviceName: async () => 'Hall',
      },
      listObjectEventsSince: async () => [],
      listRecentTracks: async () => [],
      listDeviceIdentities: async () => [
        { deviceId: 104, type: DeviceType.Camera, name: 'Hall', isCamera: true },
      ],
      drainIntervalMs: 3_600_000,
      ruleReloadIntervalMs: 3_600_000,
    })
    centers.push(center)
    await center.start({ evaluation: true })
    await center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Exports',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['export-completed'] } },
        targets: [{ targetId: 'phone' }],
        media: { attach: 'none' },
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })

    center.onSystemEvent(
      createEvent(
        'recording.export.completed',
        { type: 'addon', id: 'recorder' },
        {
          exportId: 'exp-both',
          fileBytes: 4_000,
          deviceId: 104,
          notifyTargetIds: ['phone', 'telegram'],
        },
      ),
    )

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(2)
    })
    const rows = [...(ncTable(world, 'outbox')?.values() ?? [])]
    const byTarget = Object.fromEntries(rows.map((row) => [row['targetId'], row['ruleId']]))
    expect(byTarget['phone']).not.toBe('nc-export-notify')
    expect(byTarget['telegram']).toBe('nc-export-notify')
  })
})
