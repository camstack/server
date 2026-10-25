/**
 * The notification centre removes a deleted device's DEVICE rows, one
 * `deleteWhere` per collection on the `deviceId` column, never a node row
 * (D871). A failing collection does not stop the others and is rethrown so the
 * hook's retry finishes the job.
 */
import type { InMemoryRecords } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NC_DEVICE_ROW_KINDS, removeNcDeviceRows } from '../device-removal.js'
import { NcLivenessLedger } from '../liveness-ledger.js'
import { makeNcRecords, ncTable, type NcKindName, withNcFaults } from './support/nc-test-deps.js'

function seed(): InMemoryRecords {
  const world = makeNcRecords()
  const put = (kind: NcKindName, id: string, deviceId?: number): void => {
    world.seed(kind, { id, ...(deviceId === undefined ? {} : { deviceId }), data: {} })
  }
  put('liveness', 'device:102', 102)
  put('liveness', 'device:108', 108)
  put('liveness', 'node:agent-1')
  put('device-alerts', 'device:102:battery', 102)
  put('system-state', 'k1', 102)
  put('system-state', 'k-node', undefined)
  return world
}

const keys = (world: InMemoryRecords, kind: NcKindName): readonly string[] =>
  [...ncTable(world, kind).keys()].sort()

describe('removeNcDeviceRows (D871)', () => {
  it('removes the device rows by the deviceId column and keeps every other device and node row', async () => {
    const world = seed()
    const evict = vi.fn()

    const counts = await removeNcDeviceRows(
      { records: world.records, logger: makeSilentLogger(), evictMirrors: evict },
      102,
    )

    expect(keys(world, 'liveness')).toEqual(['device:108', 'node:agent-1'])
    expect(keys(world, 'device-alerts')).toEqual([])
    expect(keys(world, 'system-state')).toEqual(['k-node'])
    expect(counts['nc-liveness']).toBe(1)
    expect(counts['nc-device-alerts']).toBe(1)
    expect(Object.keys(counts)).toHaveLength(NC_DEVICE_ROW_KINDS.length)
    expect(evict).toHaveBeenCalledWith(102)
  })

  it('is idempotent: a second run deletes nothing', async () => {
    const world = seed()
    const deps = { records: world.records, logger: makeSilentLogger(), evictMirrors: vi.fn() }
    await removeNcDeviceRows(deps, 102)

    const again = await removeNcDeviceRows(deps, 102)

    expect(Object.values(again).every((n) => n === 0)).toBe(true)
  })

  it('attempts every collection, then rethrows when one failed', async () => {
    const world = seed()
    const failing = withNcFaults(world, {
      write: (kind) => (kind === 'device-alerts' ? 'sqlite busy' : null),
    })

    await expect(
      removeNcDeviceRows(
        { records: failing.records, logger: makeSilentLogger(), evictMirrors: () => undefined },
        102,
      ),
    ).rejects.toThrow('sqlite busy')

    // The collections after the failing one were still cleaned.
    expect(keys(world, 'system-state')).toEqual(['k-node'])
    expect(keys(world, 'device-alerts')).toEqual(['device:102:battery'])
  })
})

describe('liveness mirror eviction', () => {
  it('drops only the device rows from the mirror', async () => {
    const world = makeNcRecords()
    const ledger = new NcLivenessLedger({ records: world.records, logger: makeSilentLogger() })
    await ledger.load()
    ledger.observe(
      { subject: 'device:102', kind: 'device-offline', state: 'offline', deviceId: 102 },
      1,
    )
    ledger.observe(
      { subject: 'device:108', kind: 'device-offline', state: 'offline', deviceId: 108 },
      1,
    )
    ledger.observe({ subject: 'node:agent-1', kind: 'node-offline', state: 'offline' }, 1)

    expect(ledger.evictDevice(102)).toBe(1)
    expect(
      ledger
        .snapshot()
        .map((r) => r.subject)
        .sort(),
    ).toEqual(['device:108', 'node:agent-1'])
    expect(ledger.evictDevice(102)).toBe(0)
  })
})
