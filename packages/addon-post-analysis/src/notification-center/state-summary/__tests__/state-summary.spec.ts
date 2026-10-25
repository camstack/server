/**
 * D647 — what a state summary SAYS: the current state per section, after the
 * rule's own filters; cleared items absent; an unread source "unavailable",
 * never "none"; nothing to report = empty.
 */
import { DeviceType, NcRuleInputSchema, type NcRuleInput } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcOpenAlert } from '../../alerts/open-alert.js'
import type { NcDeviceIdentity } from '../../device-directory.js'
import {
  incomingFromBatteryBand,
  incomingFromConsumableBand,
  incomingFromProviderConsumableBand,
  type NcSystemEventFacts,
} from '../../event-intake.js'
import { legacyConsumableSubject } from '../../alerts/consumable-subject.js'
import type { NcLivenessRow } from '../../liveness-ledger.js'
import { NcTextCatalog } from '../../text-catalog.js'
import { stateSources, type NcStateSourcePorts } from '../state-sources.js'
import { collectStateSummary, isEmptyStateSummary, stateSummaryText } from '../state-summary.js'
import type { NcSystemStateRow } from '../system-state-ledger.js'

const NOW = Date.UTC(2026, 8, 26, 8, 0)
const FACTS: NcSystemEventFacts = { eventId: 'x', timestamp: NOW, category: 'test', data: {} }

const DEVICES: Readonly<Record<number, NcDeviceIdentity>> = {
  10: { deviceId: 10, type: DeviceType.Sensor, name: 'Sensore porta', isCamera: false },
  11: { deviceId: 11, type: DeviceType.Sensor, name: 'Termometro', isCamera: false },
  20: { deviceId: 20, type: DeviceType.Camera, name: 'Front door', isCamera: true },
  30: { deviceId: 30, type: 'vacuum', name: 'Robot', isCamera: false },
  // Dreame (and similar) register the vacuum under a container — parent set.
  4384: {
    deviceId: 4384,
    type: DeviceType.Container,
    name: 'Robot piano terra',
    isCamera: false,
  },
  4385: {
    deviceId: 4385,
    type: 'vacuum',
    name: 'Robot piano terra',
    isCamera: false,
    parentDeviceId: 4384,
  },
  12: { deviceId: 12, type: 'dishwasher', name: 'Lavastoviglie', isCamera: false },
}
const lookup = (id: number): NcDeviceIdentity | undefined => DEVICES[id]
/** The node directory: known nodes and whether each is online. */
const NODES: ReadonlyMap<string, boolean> = new Map([
  ['hub', true],
  ['agent-1', false],
])

function battery(deviceId: number, percentage: number): NcOpenAlert {
  const subject = incomingFromBatteryBand({
    facts: FACTS,
    deviceId,
    band: 'low',
    reading: { percentage, lastUpdated: NOW },
    identity: lookup(deviceId),
  }).subject.systemEvent
  if (subject === undefined) throw new Error('no subject')
  return { family: 'battery', since: NOW - 3_600_000, subject, measured: true }
}

function consumable(deviceId: number, threshold: number, level: number): NcOpenAlert {
  const subject = incomingFromConsumableBand({
    facts: FACTS,
    deviceId,
    band: 'low',
    item: { key: 'filter', label: 'Filtro', level, status: 'ok' },
    thresholdPercent: threshold,
    identity: lookup(deviceId),
  }).subject.systemEvent
  if (subject === undefined) throw new Error('no subject')
  return { family: 'consumable', since: NOW - 7_200_000, subject, measured: true }
}

function providerLow(
  deviceId: number,
  key: string,
  label: string,
  form: 'tank' | 'product',
  since: number,
): NcOpenAlert {
  const subject = incomingFromProviderConsumableBand({
    facts: FACTS,
    deviceId,
    band: 'low',
    item: { key, label, form },
    attention: 'low',
    identity: lookup(deviceId),
  }).subject.systemEvent
  if (subject === undefined) throw new Error('no subject')
  return { family: 'consumable', since, subject, measured: true }
}

function wearPart(
  deviceId: number,
  key: string,
  label: string,
  level: number,
  since: number,
): NcOpenAlert {
  const subject = incomingFromConsumableBand({
    facts: FACTS,
    deviceId,
    band: 'low',
    item: { key, label, level, status: 'ok' },
    thresholdPercent: 15,
    identity: lookup(deviceId),
  }).subject.systemEvent
  if (subject === undefined) throw new Error('no subject')
  return { family: 'consumable', since, subject, measured: true }
}

function ports(over: Partial<NcStateSourcePorts> = {}): NcStateSourcePorts {
  return {
    alerts: () => [],
    liveness: () => [],
    state: () => [],
    lookup,
    devicesAnswered: () => true,
    nodes: { complete: true, online: (id) => (NODES.has(id) ? NODES.get(id) : undefined) },
    livenessHoldoffMs: 5 * 60_000,
    ...over,
  }
}

function rule(systemEvent: Record<string, unknown>): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'Stato',
    delivery: 'system-event',
    conditions: { systemEvent },
    targets: [{ targetId: 't' }],
  })
}

function collect(r: NcRuleInput, p: NcStateSourcePorts, muted: readonly number[] = []) {
  return collectStateSummary({
    rule: r,
    sources: stateSources(p),
    nowMs: NOW,
    isMuted: (id) => muted.includes(id),
  })
}

function words(r: NcRuleInput, p: NcStateSourcePorts, muted: readonly number[] = []) {
  return stateSummaryText({
    texts: new NcTextCatalog({ language: 'en' }),
    summary: collect(r, p, muted),
    nowMs: NOW,
    timeZone: 'UTC',
  })
}

describe('state summary — content', () => {
  it('reports the CURRENT state per section, one line per item', () => {
    const offline: NcLivenessRow = {
      subject: 'device:20',
      state: 'offline',
      kind: 'device-offline',
      deviceId: 20,
      updatedAt: NOW - 3_600_000,
    }
    const text = words(
      rule({ kinds: ['device-battery-low', 'device-offline'] }),
      ports({ alerts: () => [battery(10, 8)], liveness: () => [offline] }),
    )
    expect(text.count).toBe(2)
    expect(text.text).toContain('Low batteries:\n• Sensore porta is down to 8% battery')
    expect(text.text).toContain('Offline or off:\n• Front door — offline (since 07:00 AM)')
    expect(text.sectionVars['summaryBattery']).toContain('Sensore porta')
    expect(text.sectionVars['summaryDevices']).toContain('Front door')
  })

  it('a section the rule did not select is not reported, whatever is open there', () => {
    const text = words(
      rule({ kinds: ['device-battery-low'] }),
      ports({ alerts: () => [battery(10, 8), consumable(30, 15, 5)] }),
    )
    expect(text.text).not.toContain('Robot')
    expect(Object.keys(text.sectionVars)).toEqual(['summaryBattery'])
  })

  it("applies the rule's filters — deviceIds, excludeDeviceIds, deviceTypes", () => {
    const alerts = () => [battery(10, 8), battery(11, 3)]
    expect(
      words(rule({ kinds: ['device-battery-low'], deviceIds: [11] }), ports({ alerts })).text,
    ).not.toContain('Sensore porta')
    const excluded = collect(
      rule({ kinds: ['device-battery-low'], excludeDeviceIds: [11] }),
      ports({ alerts }),
    )
    expect(excluded.itemCount).toBe(1)
    expect(excluded.dropped).toEqual({ excludeDeviceIds: 1 })
    const cameras = collect(
      rule({ kinds: ['device-battery-low'], deviceTypes: ['camera'] }),
      ports({ alerts }),
    )
    expect(cameras.itemCount).toBe(0)
  })

  it('applies nodeIds and packageNames on a system rule', () => {
    const rows: NcSystemStateRow[] = [
      {
        key: 'update:addon:hub:@camstack/addon-recorder',
        kind: 'addon-update-available',
        since: NOW - 60_000,
        nodeId: 'hub',
        packageName: '@camstack/addon-recorder',
        params: {
          packageName: '@camstack/addon-recorder',
          currentVersion: '1.0.0',
          latestVersion: '1.0.1',
          nodeId: 'hub',
        },
      },
      {
        key: 'update:addon:agent-1:@camstack/addon-notifiers',
        kind: 'addon-update-available',
        since: NOW - 60_000,
        nodeId: 'agent-1',
        packageName: '@camstack/addon-notifiers',
        params: {
          packageName: '@camstack/addon-notifiers',
          currentVersion: '2.0.0',
          latestVersion: '2.1.0',
          nodeId: 'agent-1',
        },
      },
    ]
    const byNode = words(
      rule({ kinds: ['addon-update-available'], nodeIds: ['agent-1'] }),
      ports({ state: () => rows }),
    )
    // D708: an addon update is in the ADDON UPDATES section, under its node's heading.
    expect(byNode.text).toBe('Addon updates:\nagent-1:\n• @camstack/addon-notifiers 2.0.0 → 2.1.0')
    const byPackage = collect(
      rule({ kinds: ['addon-update-available'], packageNames: ['@camstack/addon-recorder'] }),
      ports({ state: () => rows }),
    )
    expect(byPackage.dropped).toEqual({ packageNames: 1 })
  })

  it("judges consumables at the RULE's threshold — the episode of another threshold is not this rule's", () => {
    const alerts = () => [consumable(30, 25, 20), consumable(30, 10, 20)]
    const at25 = words(
      rule({ kinds: ['device-consumable-low'], consumableLowPercent: 25 }),
      ports({ alerts }),
    )
    expect(at25.count).toBe(1)
    expect(at25.text).toContain('• Filtro 20%')
    // The default (15) hears neither episode.
    expect(collect(rule({ kinds: ['device-consumable-low'] }), ports({ alerts })).itemCount).toBe(0)
  })

  it('a CLEARED state is absent — only what the mirrors still hold open is reported', () => {
    const back: NcLivenessRow = {
      subject: 'device:20',
      state: 'online',
      kind: 'device-online',
      deviceId: 20,
      updatedAt: NOW - 60_000,
    }
    const summary = collect(rule({ kinds: ['device-offline'] }), ports({ liveness: () => [back] }))
    expect(summary.itemCount).toBe(0)
    expect(isEmptyStateSummary(summary)).toBe(true)
  })

  it('a device offline for less than the hold-off is not reported yet (the instant rule would not have spoken)', () => {
    const blip: NcLivenessRow = {
      subject: 'device:20',
      state: 'offline',
      kind: 'device-offline',
      deviceId: 20,
      updatedAt: NOW - 60_000,
    }
    expect(
      collect(rule({ kinds: ['device-offline'] }), ports({ liveness: () => [blip] })).itemCount,
    ).toBe(0)
  })

  it('a MUTED device is left out, as its instant event would be', () => {
    const summary = collect(
      rule({ kinds: ['device-battery-low'] }),
      ports({ alerts: () => [battery(10, 8)] }),
      [10],
    )
    expect(summary.itemCount).toBe(0)
    expect(summary.dropped).toEqual({ muted: 1 })
  })

  it('a vacuum child of its container still reports an open consumable (2026-10-05)', () => {
    const summary = collect(
      rule({ kinds: ['device-consumable-low'] }),
      ports({
        alerts: () => [providerLow(4385, 'cleanWater', 'acqua pulita', 'tank', NOW - 3_600_000)],
      }),
    )
    expect(summary.itemCount).toBe(1)
    expect(summary.sections.map((s) => s.id)).toEqual(['consumables'])
    expect(summary.sections[0]?.items[0]?.subject.subject).toBe(
      legacyConsumableSubject(4385, 'cleanWater'),
    )
  })

  it('one consumables section when the rule lists several consumable kinds (D934)', () => {
    const alerts = () => [
      providerLow(4385, 'cleanWater', 'acqua pulita', 'tank', NOW - 4_000_000),
      wearPart(4385, 'sensor', 'Sensor Dirty', 0, NOW - 3_000_000),
      wearPart(4385, 'wheel', 'Wheel Dirty', 0, NOW - 2_000_000),
      providerLow(12, 'rinse', 'brillantante', 'product', NOW - 1_500_000),
      providerLow(12, 'salt', 'sale', 'product', NOW - 1_000_000),
    ]
    const text = words(
      rule({ kinds: ['device-consumable-low', 'device-consumable-normal'] }),
      ports({ alerts }),
    )
    expect(text.sections.map((s) => s.id)).toEqual(['consumables'])
    expect(text.text).toBe(
      [
        'Consumables:',
        'Lavastoviglie:',
        '• brillantante running out',
        '• sale running out',
        'Robot piano terra:',
        '• acqua pulita nearly empty',
        '• Sensor Dirty 0%',
        '• Wheel Dirty 0%',
      ].join('\n'),
    )
  })

  it('backups and exports are named as EXCLUDED, not reported', () => {
    const summary = collect(rule({ kinds: ['backup-completed', 'node-offline'] }), ports())
    expect(summary.excludedGroups).toEqual(['backups-exports'])
    expect(summary.sections.map((s) => s.id)).toEqual(['nodes'])
  })
})

describe('state summary — unreadable sources', () => {
  it('an unread ledger makes its section UNAVAILABLE, never empty', () => {
    const r = rule({ kinds: ['device-battery-low', 'stream-offline'] })
    const summary = collect(r, ports({ alerts: () => null }))
    expect(summary.sections).toEqual([
      expect.objectContaining({ id: 'streams', status: 'read', items: [] }),
      expect.objectContaining({ id: 'battery', status: 'unavailable' }),
    ])
    expect(isEmptyStateSummary(summary)).toBe(false)
    const text = words(r, ports({ alerts: () => null }))
    expect(text.text).toBe('Low batteries: unavailable — the state could not be read')
    expect(text.count).toBe(0)
  })

  it('nothing open and every section read is EMPTY — the summary is not sent', () => {
    const summary = collect(
      rule({ kinds: ['device-battery-low', 'addon-update-available'] }),
      ports(),
    )
    expect(isEmptyStateSummary(summary)).toBe(true)
  })
})
