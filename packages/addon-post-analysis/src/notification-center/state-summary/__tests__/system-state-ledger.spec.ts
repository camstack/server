/**
 * D647 — the system-state ledger keeps what is STILL TRUE among the
 * event-driven kinds, and forgets it when the closing event arrives.
 */
import { describe, expect, it } from 'vitest'
import type { NcSystemEventSubject } from '../../rule-engine.js'
import {
  NcSystemStateLedger,
  type NcSystemStateRow,
  type NcSystemStateRowPort,
  updateStateKey,
} from '../system-state-ledger.js'

function mapPort(
  answered = true,
): NcSystemStateRowPort & { readonly rows: Map<string, NcSystemStateRow> } {
  const rows = new Map<string, NcSystemStateRow>()
  return {
    rows,
    get: (key) => rows.get(key),
    put: (row) => {
      rows.set(row.key, row)
    },
    remove: (key) => {
      rows.delete(key)
    },
    all: () => [...rows.values()],
    answered: () => answered,
    deferWhileOpen: () => undefined,
  }
}

function subject(
  over: Partial<NcSystemEventSubject> & Pick<NcSystemEventSubject, 'kind' | 'subject'>,
): NcSystemEventSubject {
  return { data: {}, ...over }
}

describe('NcSystemStateLedger', () => {
  it('a stream offline opens a row; the stream coming back closes it; a repeat keeps the first since', () => {
    const port = mapPort()
    const ledger = new NcSystemStateLedger({ rows: port })
    const offline = subject({
      kind: 'stream-offline',
      subject: 'stream:20',
      deviceId: 20,
      textParams: { deviceName: 'Front door', profile: 'high' },
    })
    ledger.observe(offline, 1_000)
    ledger.observe(offline, 5_000)
    expect(ledger.openRows()).toEqual([
      expect.objectContaining({
        key: 'stream:20',
        kind: 'stream-offline',
        since: 1_000,
        deviceId: 20,
      }),
    ])
    ledger.observe(subject({ kind: 'stream-online', subject: 'stream:20', deviceId: 20 }), 9_000)
    expect(ledger.openRows()).toEqual([])
  })

  describe('one-time migration of the pre-D883 per-cam-stream keys', () => {
    function legacyRow(key: string, deviceId: number): NcSystemStateRow {
      return {
        key,
        kind: 'stream-offline',
        since: 1,
        deviceId,
        titleKey: 'system.stream-offline.title',
        bodyKey: 'system.stream-offline.body',
        params: {},
      } as NcSystemStateRow
    }

    it('closes an open row whose subject is not stream:<deviceId> as soon as the ledger exists', () => {
      const port = mapPort()
      port.rows.set('stream:native:main', legacyRow('stream:native:main', 20))
      port.rows.set('stream:20', legacyRow('stream:20', 20))
      new NcSystemStateLedger({ rows: port })
      expect([...port.rows.keys()]).toEqual(['stream:20'])
    })

    it('a stream.online of a device also closes its legacy per-stream rows', () => {
      const port = mapPort()
      const ledger = new NcSystemStateLedger({ rows: port })
      port.rows.set('stream:native:sub', legacyRow('stream:native:sub', 20))
      port.rows.set('stream:21', legacyRow('stream:21', 21))
      ledger.observeStreamOnline(20)
      expect([...port.rows.keys()]).toEqual(['stream:21'])
    })

    it('a hub restart mid-outage: the first-packet online of the new broker closes the open row', () => {
      const port = mapPort()
      port.rows.set('stream:20', legacyRow('stream:20', 20))
      const ledger = new NcSystemStateLedger({ rows: port })
      // The restarted manager has no outage record: its first healthy packet is
      // a `first-packet` online, which the intake gate drops but the ledger hears.
      ledger.observeStreamOnline(20)
      expect(ledger.openRows()).toEqual([])
    })
  })

  it('the device switch: disabled opens, enabled closes', () => {
    const ledger = new NcSystemStateLedger({ rows: mapPort() })
    ledger.observe(
      subject({ kind: 'device-disabled', subject: 'device-switch:20', deviceId: 20 }),
      1,
    )
    expect(ledger.openRows()).toHaveLength(1)
    ledger.observe(
      subject({ kind: 'device-enabled', subject: 'device-switch:20', deviceId: 20 }),
      2,
    )
    expect(ledger.openRows()).toEqual([])
  })

  it('a camera detecting nothing stays open until a DETECTION on that camera — not on another', () => {
    const ledger = new NcSystemStateLedger({ rows: mapPort() })
    ledger.observe(
      subject({ kind: 'detection-blind', subject: 'detection-blind:20', deviceId: 20 }),
      1,
    )
    ledger.observeDetection(21)
    expect(ledger.openRows()).toHaveLength(1)
    ledger.observeDetection(20)
    expect(ledger.openRows()).toEqual([])
  })

  it('updates are one row per package per node; addon.updated closes that one only', () => {
    const ledger = new NcSystemStateLedger({ rows: mapPort() })
    ledger.observeUpdateList(
      {
        target: 'addon',
        nodeIds: ['hub', 'agent-1'],
        rows: [
          {
            packageName: '@camstack/addon-recorder',
            currentVersion: '1.0.0',
            latestVersion: '1.0.1',
            nodeId: 'hub',
          },
          {
            packageName: '@camstack/addon-recorder',
            currentVersion: '1.0.0',
            latestVersion: '1.0.1',
            nodeId: 'agent-1',
          },
        ],
      },
      1,
    )
    expect(
      ledger
        .openRows()
        ?.map((row) => row.key)
        .toSorted(),
    ).toEqual([
      updateStateKey('addon', 'agent-1', '@camstack/addon-recorder'),
      updateStateKey('addon', 'hub', '@camstack/addon-recorder'),
    ])
    ledger.observeAddonUpdated({
      packageName: '@camstack/addon-recorder',
      toVersion: '1.0.1',
      nodeId: 'agent-1',
    })
    expect(ledger.openRows()?.map((row) => row.key)).toEqual([
      updateStateKey('addon', 'hub', '@camstack/addon-recorder'),
    ])
  })

  it('a server update on a node closes its server/container updates and its node faults', () => {
    const ledger = new NcSystemStateLedger({ rows: mapPort() })
    ledger.observeUpdateList(
      {
        target: 'server',
        nodeIds: ['hub'],
        rows: [
          {
            packageName: '@camstack/server',
            currentVersion: '1',
            latestVersion: '2',
            nodeId: 'hub',
          },
        ],
      },
      1,
    )
    ledger.observe(
      subject({ kind: 'addon-crash-loop', subject: 'addon-crash:hub:r1', nodeId: 'hub' }),
      1,
    )
    ledger.observe(
      subject({ kind: 'addon-crash-loop', subject: 'addon-crash:agent-1:r1', nodeId: 'agent-1' }),
      1,
    )
    ledger.observe(
      subject({ kind: 'server-updated', subject: 'server-updated:hub:2', nodeId: 'hub' }),
      2,
    )
    expect(ledger.openRows()?.map((row) => row.key)).toEqual(['addon-crash:agent-1:r1'])
    ledger.observe(subject({ kind: 'node-online', subject: 'node:agent-1', nodeId: 'agent-1' }), 3)
    expect(ledger.openRows()).toEqual([])
  })

  it('answers null — not "nothing open" — while its store has never been read', () => {
    const ledger = new NcSystemStateLedger({ rows: mapPort(false) })
    ledger.observe(
      subject({ kind: 'detection-blind', subject: 'detection-blind:20', deviceId: 20 }),
      1,
    )
    expect(ledger.openRows()).toBeNull()
  })

  it('a deleted device takes its rows with it', () => {
    const ledger = new NcSystemStateLedger({ rows: mapPort() })
    ledger.observe(
      subject({ kind: 'detection-blind', subject: 'detection-blind:20', deviceId: 20 }),
      1,
    )
    ledger.observe(
      subject({ kind: 'device-disabled', subject: 'device-switch:21', deviceId: 21 }),
      1,
    )
    expect(ledger.deviceIds().toSorted()).toEqual([20, 21])
    expect(ledger.forgetDevice(20)).toBe(1)
    expect(ledger.deviceIds()).toEqual([21])
  })
})
