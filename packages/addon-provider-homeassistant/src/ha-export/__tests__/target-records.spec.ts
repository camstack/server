/**
 * The `ha-export-targets` records are the only home of a target's connection, switch, media role,
 * cadence and devices. Disarm: let `isEnabled` default to false for an absent field (the D996 rule
 * is "absent means on") and "a record without `enabled` is on" fails; let `setMembership` write the
 * whole body instead of patching `devices` and "keeps a rename made through the instances door"
 * fails; mint ids from a count instead of the highest and "never reuses a live id" fails.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type HaExportTargetBody,
  ExportTargets,
  haExportTargetsKind,
  newTargetBody,
  nextTargetId,
} from '../target-records.js'

async function open() {
  const memory = makeInMemoryRecords('homeassistant-export')
  await memory.records.declare({ 'ha-export-targets': haExportTargetsKind })
  const handle = memory.records.kind(haExportTargetsKind)
  return { handle, load: () => ExportTargets.load(handle) }
}

const HOME: HaExportTargetBody = {
  name: 'Home',
  connectionId: 'ha_001',
  mediaRole: 'publicEndpoint',
  reconcileIntervalSec: 300,
  devices: ['7'],
}

describe('ExportTargets', () => {
  it('holds nothing for an empty store, and the default cadence', async () => {
    const targets = await (await open()).load()
    expect(targets.ids()).toEqual([])
    expect(targets.isEnabled('hae_001')).toBe(false)
    expect(targets.membership()).toEqual({})
    expect(targets.reconcileIntervalSec()).toBe(300)
  })

  it('reads the connection, switch, role and devices from the record, per target', async () => {
    const { handle, load } = await open()
    await handle.put({ id: 'hae_001', data: HOME })
    await handle.put({
      id: 'hae_002',
      data: {
        ...newTargetBody('Cabin'),
        connectionId: 'ha_001',
        enabled: false,
      },
    })
    const targets = await load()
    expect(targets.isEnabled('hae_001')).toBe(true)
    expect(targets.isEnabled('hae_002')).toBe(false)
    expect(targets.connectionId('hae_002')).toBe('ha_001')
    expect(targets.mediaRole('hae_001')).toBe('publicEndpoint')
    expect(targets.membership()).toEqual({ hae_001: ['7'] })
  })

  it('runs one timer at the quickest enabled cadence, never under the floor', async () => {
    const { handle, load } = await open()
    await handle.put({
      id: 'hae_001',
      data: { ...HOME, reconcileIntervalSec: 600 },
    })
    await handle.put({
      id: 'hae_002',
      data: { ...HOME, reconcileIntervalSec: 120 },
    })
    await handle.put({
      id: 'hae_003',
      data: { ...HOME, reconcileIntervalSec: 5, enabled: false },
    })
    expect((await load()).reconcileIntervalSec()).toBe(120)
    await handle.put({
      id: 'hae_002',
      data: { ...HOME, reconcileIntervalSec: 1 },
    })
    expect((await load()).reconcileIntervalSec()).toBe(30)
  })

  it('persists a device change by patching devices only, keeping a rename made elsewhere', async () => {
    const { handle, load } = await open()
    await handle.put({ id: 'hae_001', data: HOME })
    const targets = await load()
    await handle.patch('hae_001', { name: 'Renamed' })
    await targets.setMembership({ hae_001: ['7', '9'] })
    expect((await handle.get('hae_001'))?.data).toMatchObject({
      name: 'Renamed',
      devices: ['7', '9'],
    })
    expect(targets.membership()).toEqual({ hae_001: ['7', '9'] })
  })

  it('never creates a target from a membership write for an unknown id', async () => {
    const { handle, load } = await open()
    const targets = await load()
    await targets.setMembership({ hae_404: ['1'] })
    expect((await handle.query({ limit: 10 })).records).toEqual([])
  })

  it('reloads what the instances door wrote', async () => {
    const { handle, load } = await open()
    const targets = await load()
    await handle.put({ id: 'hae_001', data: HOME })
    expect(targets.ids()).toEqual([])
    await targets.reload()
    expect(targets.ids()).toEqual(['hae_001'])
  })
})

describe('nextTargetId', () => {
  it('starts at hae_001 and follows the highest id, not the count', () => {
    expect(nextTargetId([])).toBe('hae_001')
    expect(nextTargetId(['hae_001', 'hae_007'])).toBe('hae_008')
    expect(nextTargetId(['other', 'hae_x'])).toBe('hae_001')
  })
})
