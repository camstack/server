/**
 * D642 end to end, through the real centre: the operator's own sentence.
 *
 * "A rule with threshold 25 must be told about an item at 20 %; a rule with 10
 * must not." Two device-events rules, one `consumables` slice write — and the
 * outbox holds exactly one row, for the rule at 25. Then the SAME `consumables`
 * slice, now carrying the vacuum's tanks as `supply` / `waste` items (D915 —
 * they moved off `vacuum-control`), reaches the tank rule with the dust bin
 * full.
 *
 * This drives the production rule mirror (the threshold census), the
 * production door and the production slice taps — the unit specs fake all
 * three.
 */
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { DeviceType, NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { NC_SUPPLY_HOLD_MS } from '../alerts/supply-band.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const VACUUM = 4385

function outboxRows(world: InMemoryRecords) {
  return [...(ncTable(world, 'outbox')?.values() ?? [])]
}

describe('each consumable rule hears its own threshold, and tanks reach their rule', () => {
  const centers: NotificationCenter[] = []

  afterEach(async () => {
    await Promise.all(centers.map((center) => center.stop()))
  })

  it('rule 25 is told about a filter at 20 %, rule 10 is not; a full dust bin reaches the tank rule', async () => {
    const world = makeNcRecords()
    const targets: NcTargetRef[] = [
      { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
    ]
    let clock = Date.now()
    const center = new NotificationCenter({
      deviceSettings: makeFakeDeviceSettings(),
      now: () => clock,
      records: world.records,
      logger: makeSilentLogger(),
      pruneWindows: async () => ({
        outboxMs: null,
        timelapseExportMs: null,
        artifactShelfMs: null,
        summaryMosaicMs: null,
      }),
      dispatcher: {
        listTargets: async () => targets,
        send: async () => ({ success: true }),
        getMediaForOwner: async () => [],
        getDeviceName: async () => 'Robot piano terra',
      },
      listObjectEventsSince: async () => [],
      listRecentTracks: async () => [],
      listDeviceIdentities: async () => [
        { deviceId: VACUUM, type: DeviceType.Vacuum, name: 'Robot piano terra', isCamera: false },
      ],
      drainIntervalMs: 3_600_000,
      ruleReloadIntervalMs: 40,
      readDeviceAlertSettings: () => ({
        batteryLowPercent: 20,
        renotifyMinutes: 720,
        notifyRecovery: true,
      }),
    })
    centers.push(center)
    await center.start({ evaluation: true })
    const provider = center.buildProvider()
    const caller = { userId: 'admin', isAdmin: true }
    const ruleOf = (name: string, systemEvent: Record<string, unknown>) =>
      NcRuleInputSchema.parse({
        name,
        delivery: 'system-event',
        conditions: { systemEvent },
        targets: [{ targetId: 'target-1' }],
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      })
    const at25 = await provider.createRule({
      caller,
      rule: ruleOf('Consumabili 25', {
        kinds: ['device-consumable-low'],
        consumableLowPercent: 25,
      }),
    })
    await provider.createRule({
      caller,
      rule: ruleOf('Consumabili 10', {
        kinds: ['device-consumable-low'],
        consumableLowPercent: 10,
      }),
    })
    const tanks = await provider.createRule({
      caller,
      rule: ruleOf('Serbatoi', { kinds: ['device-consumable-low'] }),
    })

    center.onSystemEvent({
      id: 'consumables-slice',
      timestamp: new Date(),
      source: { type: 'device', id: VACUUM },
      category: 'device.state-changed',
      data: {
        deviceId: VACUUM,
        capName: 'consumables',
        slice: {
          items: [{ key: 'filter', label: 'Filtro', level: 20, status: null }],
          lastChangedAt: 1,
          lastFetchedAt: 1,
        },
      },
    })
    await vi.waitFor(() => expect(outboxRows(world)).toHaveLength(1), { timeout: 2_000 })
    // Several reload ticks later: still only the rule at 25.
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    expect(outboxRows(world).map((row) => row['ruleId'])).toEqual([at25.rule.id])
    expect(outboxRows(world)[0]?.['payload']).toMatchObject({
      subject: {
        systemEvent: { kind: 'device-consumable-low', subject: `consumable@25:${VACUUM}:filter` },
      },
    })

    center.onSystemEvent({
      id: 'consumables-slice-tanks',
      timestamp: new Date(),
      source: { type: 'device', id: VACUUM },
      category: 'device.state-changed',
      data: {
        deviceId: VACUUM,
        capName: 'consumables',
        slice: {
          items: [
            { key: 'filter', label: 'Filtro', level: 20, status: null },
            { key: 'cleanWater', label: 'Clean water', level: null, status: 'ok', kind: 'supply' },
            { key: 'dustBin', label: 'Dust bin', level: null, status: 'full', kind: 'waste' },
          ],
          lastChangedAt: 2,
          lastFetchedAt: 2,
        },
      },
    })
    // A tank change counts once it has HELD (review M2): nothing yet…
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    expect(outboxRows(world)).toHaveLength(1)
    // …and the reload tick confirms it once the hold has passed, with no
    // further slice write.
    clock += NC_SUPPLY_HOLD_MS
    await vi.waitFor(
      () => expect(outboxRows(world).some((row) => row['ruleId'] === tanks.rule.id)).toBe(true),
      { timeout: 2_000 },
    )
    const tankRow = outboxRows(world).find((row) => row['ruleId'] === tanks.rule.id)
    expect(tankRow?.['payload']).toMatchObject({
      subject: {
        systemEvent: { kind: 'device-consumable-low', subject: `consumable:${VACUUM}:dustBin` },
      },
    })
    // Provider-verdict items omit `consumableLowPercent`, so every consumable-low rule matches — not only the tank-named one.
    expect(outboxRows(world).length).toBeGreaterThanOrEqual(2)
  })
})
