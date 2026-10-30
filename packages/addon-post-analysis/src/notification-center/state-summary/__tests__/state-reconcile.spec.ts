/**
 * D647 fix round 1 — the "current state" must be TRUE: rows close on every
 * proof the state is over, update lists replace, and every row is reconciled
 * against the directories before it is listed.
 */
import { makeNcRecords } from '../../__tests__/support/nc-test-deps.js'
import { DeviceType, NcRuleInputSchema, type NcRuleInput } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcDeviceIdentity } from '../../device-directory.js'
import type { NcLivenessRow } from '../../liveness-ledger.js'
import type { NcSystemEventSubject } from '../../rule-engine.js'
import { type NcNodeView, stateSources, type NcStateSourcePorts } from '../state-sources.js'
import { collectStateSummary } from '../state-summary.js'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import { NcTextCatalog } from '../../text-catalog.js'
import { NcStateSummaryService, updateListOf } from '../state-summary-service.js'
import {
  NcSystemStateLedger,
  type NcSystemStateRow,
  type NcSystemStateRowPort,
  updateStateKey,
} from '../system-state-ledger.js'

const NOW = Date.UTC(2026, 8, 26, 8, 0)

function mapPort(): NcSystemStateRowPort {
  const rows = new Map<string, NcSystemStateRow>()
  return {
    get: (key) => rows.get(key),
    put: (row) => {
      rows.set(row.key, row)
    },
    remove: (key) => {
      rows.delete(key)
    },
    all: () => [...rows.values()],
    answered: () => true,
    deferWhileOpen: () => undefined,
  }
}

function subject(
  over: Partial<NcSystemEventSubject> & Pick<NcSystemEventSubject, 'kind' | 'subject'>,
): NcSystemEventSubject {
  return { data: {}, ...over }
}

function keys(ledger: NcSystemStateLedger): readonly string[] {
  return (ledger.openRows() ?? []).map((row) => row.key).toSorted()
}

describe('I1 — a stream row closes on ANY stream.online', () => {
  it('the first packet of a recreated broker (dropped by the intake gate) still closes it', () => {
    const ledger = new NcSystemStateLedger({ rows: mapPort() })
    ledger.observe(subject({ kind: 'stream-offline', subject: 'stream:20', deviceId: 20 }), 1)
    ledger.observeStreamOnline(20)
    expect(keys(ledger)).toEqual([])
  })
})

describe('I3 — an update.available list REPLACES the rows of its node', () => {
  const recorder = {
    packageName: '@camstack/addon-recorder',
    currentVersion: '1',
    latestVersion: '2',
  }
  const notifiers = {
    packageName: '@camstack/addon-notifiers',
    currentVersion: '3',
    latestVersion: '4',
  }

  it('a package missing from the next list is current; another node is untouched', () => {
    const ledger = new NcSystemStateLedger({ rows: mapPort() })
    ledger.observeUpdateList(
      {
        target: 'addon',
        nodeIds: ['hub', 'agent-1'],
        rows: [
          { ...recorder, nodeId: 'hub' },
          { ...notifiers, nodeId: 'hub' },
          { ...recorder, nodeId: 'agent-1' },
        ],
      },
      1,
    )
    ledger.observeUpdateList(
      {
        target: 'addon',
        nodeIds: ['hub'],
        rows: [{ ...notifiers, nodeId: 'hub' }],
      },
      2,
    )
    expect(keys(ledger)).toEqual(
      [
        updateStateKey('addon', 'agent-1', recorder.packageName),
        updateStateKey('addon', 'hub', notifiers.packageName),
      ].toSorted(),
    )
  })

  it('an EMPTY list for a node clears it — defensive: the emitter never sends one', () => {
    const ledger = new NcSystemStateLedger({ rows: mapPort() })
    const full = updateListOf({
      target: 'server',
      nodeId: 'hub',
      packages: [{ ...notifiers, packageName: '@camstack/server' }],
    })
    const empty = updateListOf({
      target: 'server',
      nodeId: 'hub',
      packages: [],
    })
    if (full === null || empty === null) throw new Error('not parsed')
    ledger.observeUpdateList(full, 1)
    expect(keys(ledger)).toHaveLength(1)
    expect(empty.nodeIds).toEqual(['hub'])
    ledger.observeUpdateList(empty, 2)
    expect(keys(ledger)).toEqual([])
    // A list that names no node and carries nothing speaks for nobody.
    expect(updateListOf({ target: 'addon', packages: [] })?.nodeIds).toEqual([])
    expect(updateListOf({ target: 'nonsense' })).toBeNull()
  })
})

describe('I5 — what revives a crash-looped runner or a node that could not infer', () => {
  it('an addon of the runner STARTING on that node closes the crash row; another node does not', () => {
    const ledger = new NcSystemStateLedger({ rows: mapPort() })
    ledger.observe(
      subject({
        kind: 'addon-crash-loop',
        subject: 'addon-crash:hub:r1',
        nodeId: 'hub',
        textParams: { nodeId: 'hub', addons: 'recorder, onvif' },
      }),
      1,
    )
    ledger.observeAddonStarted('onvif', 'agent-1')
    expect(keys(ledger)).toEqual(['addon-crash:hub:r1'])
    ledger.observeAddonStarted('onvif', 'hub')
    expect(keys(ledger)).toEqual([])
  })

  it('the node is the event SOURCE node, not data.agent (a display name); a node-less start is the hub only', async () => {
    const world = makeNcRecords()
    const service = new NcStateSummaryService({
      records: world.records,
      logger: makeSilentLogger(),
      now: () => NOW,
      rules: () => [],
      alerts: () => [],
      liveness: () => [],
      lookup: () => undefined,
      devicesAnswered: () => true,
      livenessHoldoffMs: 0,
      isMuted: () => false,
      texts: () => new NcTextCatalog(),
      enqueue: async () => ({ inserted: 0, targetIds: [] }),
    })
    await service.load()
    const ledger = service.ledger
    const crash = (nodeId: string) =>
      ledger.observe(
        subject({
          kind: 'addon-crash-loop',
          subject: `addon-crash:${nodeId}:r1`,
          nodeId,
          textParams: { nodeId, addons: 'onvif' },
        }),
        1,
      )
    crash('hub')
    crash('agent-7f3a')
    // On an agent, `data.agent` is its NAME — the row carries the broker node id.
    service.observeRawEvent(
      'addon.started',
      { addonId: 'onvif', agent: 'Garage box' },
      2,
      'agent-7f3a',
    )
    expect(service.ledger.openRows()?.map((row) => row.key)).toEqual(['addon-crash:hub:r1'])
    crash('agent-7f3a')
    // An in-process start names no node: it is the hub's, and closes the hub's row only.
    service.observeRawEvent('addon.restarted', { addonId: 'onvif' }, 3)
    expect(service.ledger.openRows()?.map((row) => row.key)).toEqual(['addon-crash:agent-7f3a:r1'])
  })

  it('the balancer placing a camera on the node closes its inference row', () => {
    const ledger = new NcSystemStateLedger({ rows: mapPort() })
    ledger.observe(
      subject({
        kind: 'node-inference-unavailable',
        subject: 'node-inference:agent-1',
        nodeId: 'agent-1',
      }),
      1,
    )
    ledger.observeCameraPlaced('hub')
    expect(keys(ledger)).toHaveLength(1)
    ledger.observeCameraPlaced('agent-1')
    expect(keys(ledger)).toEqual([])
  })
})

// ── I2 — the reconcile ─────────────────────────────────────────────────

const DEVICES: Readonly<Record<number, NcDeviceIdentity>> = {
  20: {
    deviceId: 20,
    type: DeviceType.Camera,
    name: 'Front door',
    isCamera: true,
    online: false,
  },
  21: {
    deviceId: 21,
    type: DeviceType.Camera,
    name: 'Garage',
    isCamera: true,
    online: true,
  },
  22: {
    deviceId: 22,
    type: DeviceType.Sensor,
    name: 'Accessorio',
    isCamera: false,
    online: false,
    parentDeviceId: 20,
  },
}

function offline(deviceId: number): NcLivenessRow {
  return {
    subject: `device:${deviceId}`,
    state: 'offline',
    kind: 'device-offline',
    deviceId,
    updatedAt: NOW - 3_600_000,
  }
}

function nodeOffline(nodeId: string): NcLivenessRow {
  return {
    subject: `node:${nodeId}`,
    state: 'offline',
    kind: 'node-offline',
    updatedAt: NOW - 3_600_000,
  }
}

function view(nodes: Readonly<Record<string, boolean>>, complete = true): NcNodeView {
  return { complete, online: (id) => nodes[id] }
}

function ports(over: Partial<NcStateSourcePorts>): NcStateSourcePorts {
  return {
    alerts: () => [],
    liveness: () => [],
    state: () => [],
    lookup: (id) => DEVICES[id],
    devicesAnswered: () => true,
    nodes: view({}),
    livenessHoldoffMs: 0,
    ...over,
  }
}

function rule(kinds: readonly string[]): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'r',
    delivery: 'system-event',
    conditions: { systemEvent: { kinds } },
    targets: [{ targetId: 't' }],
  })
}

function listed(r: NcRuleInput, p: NcStateSourcePorts): readonly string[] {
  return collectStateSummary({
    rule: r,
    sources: stateSources(p),
    nowMs: NOW,
    isMuted: () => false,
  }).sections.flatMap((section) => section.items.map((item) => item.subject.subject))
}

describe('I2 — a ledger row is listed only while the directory agrees', () => {
  it('a device that no longer exists, an accessory, or one the device manager calls online is not listed', () => {
    const p = ports({
      liveness: () => [offline(20), offline(21), offline(22), offline(99)],
    })
    expect(listed(rule(['device-offline']), p)).toEqual(['device:20'])
  })

  it('an unanswered device directory makes the device sections UNAVAILABLE — never a guess', () => {
    const summary = collectStateSummary({
      rule: rule(['device-offline']),
      sources: stateSources(ports({ liveness: () => [offline(20)], devicesAnswered: () => false })),
      nowMs: NOW,
      isMuted: () => false,
    })
    expect(summary.sections).toEqual([
      expect.objectContaining({ id: 'device-state', status: 'unavailable' }),
    ])
  })

  it('a forgotten node, or one the directory calls online, is not listed', () => {
    const p = ports({
      liveness: () => [nodeOffline('agent-1'), nodeOffline('agent-2'), nodeOffline('gone')],
      nodes: view({ 'agent-1': false, 'agent-2': true }),
    })
    expect(listed(rule(['node-offline']), p)).toEqual(['node:agent-1'])
  })

  it('a stale node:<node>/<child> worker row from an older build is never listed (R2-L1)', () => {
    const p = ports({
      liveness: () => [
        nodeOffline('agent-a'),
        nodeOffline('hub/decoder-nodeav'),
        nodeOffline('hub/provider-hikvision'),
      ],
      nodes: view({ 'agent-a': false, hub: true }),
    })
    expect(listed(rule(['node-offline']), p)).toEqual(['node:agent-a'])
  })

  it('an update row of a forgotten node is dropped', () => {
    const row = (nodeId: string): NcSystemStateRow => ({
      key: updateStateKey('addon', nodeId, 'p'),
      kind: 'addon-update-available',
      since: NOW,
      nodeId,
      packageName: 'p',
      params: {
        packageName: 'p',
        currentVersion: '1',
        latestVersion: '2',
        nodeId,
      },
    })
    const p = ports({
      state: () => [row('hub'), row('gone')],
      nodes: view({ hub: true }),
    })
    expect(listed(rule(['addon-update-available']), p)).toEqual([
      updateStateKey('addon', 'hub', 'p'),
    ])
  })

  it('an unanswered or incomplete node directory makes the node sections UNAVAILABLE', () => {
    for (const nodes of [null, view({ hub: true }, false)]) {
      const summary = collectStateSummary({
        rule: rule(['node-offline', 'addon-update-available']),
        sources: stateSources(ports({ nodes })),
        nowMs: NOW,
        isMuted: () => false,
      })
      expect(summary.sections.map((s) => s.status)).toEqual(['unavailable', 'unavailable'])
    }
  })

  it('a deleted device takes its open states with it (the prune port)', () => {
    const ledger = new NcSystemStateLedger({ rows: mapPort() })
    ledger.observe(subject({ kind: 'stream-offline', subject: 'stream:x', deviceId: 20 }), 1)
    expect(ledger.forgetDevice(20)).toBe(1)
    expect(
      listed(rule(['stream-offline']), ports({ state: () => ledger.openRows() ?? [] })),
    ).toEqual([])
  })
})

describe('D62 — a switched-off device is listed as off, never also as offline', () => {
  const disabledRow = (deviceId: number): NcSystemStateRow => ({
    key: `device-switch:${deviceId}`,
    kind: 'device-disabled',
    since: NOW,
    deviceId,
    params: {},
  })

  it('a device with an open device-disabled row drops its device-offline item', () => {
    const p = ports({
      liveness: () => [offline(20)],
      state: () => [disabledRow(20)],
    })
    const r = rule(['device-offline', 'device-disabled'])
    expect(listed(r, p)).toEqual(['device-switch:20'])
  })

  it('a device-offline of another, enabled device is still listed', () => {
    const p = ports({
      liveness: () => [offline(20)],
      state: () => [disabledRow(21)],
    })
    expect(listed(rule(['device-offline', 'device-disabled']), p)).toContain('device:20')
  })

  it('its open stream-offline row is dropped too', () => {
    const stream: NcSystemStateRow = {
      key: 'stream:20',
      kind: 'stream-offline',
      since: NOW,
      deviceId: 20,
      params: {},
    }
    const p = ports({ state: () => [disabledRow(20), stream] })
    expect(listed(rule(['stream-offline']), p)).toEqual([])
  })
})
