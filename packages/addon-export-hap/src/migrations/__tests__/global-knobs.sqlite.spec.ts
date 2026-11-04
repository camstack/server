/**
 * Migrations 6-8 of the HomeKit export on real SQLite rows: the installation name becomes the
 * default instance's name, the fixed setup code is released from the keychain, and the retired
 * global rows are deleted while the node rows (and a neighbour addon's rows) survive.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type SettingsRows,
  settingsFixture,
} from '../../../../system/src/builtins/sqlite-storage/__tests__/support/addon-settings-fixture.js'
import { HAP_DEFAULT_INSTANCE_ID, hapBridgesKind } from '../../hap-instance-kinds.js'
import {
  ADDON_MIGRATIONS,
  BRIDGE_NAME_TO_INSTANCE_ID,
  DROP_GLOBAL_KNOB_ROWS_ID,
  DROP_GLOBAL_KNOBS_ID,
  EXPORT_HAP_ID,
  type HapCataloguePorts,
} from '../index.js'

const NEIGHBOUR = 'keep-me'

interface World {
  readonly cleared: string[]
  readonly fixture: ReturnType<typeof settingsFixture<HapCataloguePorts>>
  readonly record: () => Promise<{
    readonly name: string
    readonly pincode: string
  } | null>
}

async function world(
  seed: Record<string, unknown>,
  recordName: string | null,
  vault = new Map<string, string>(),
): Promise<World> {
  const memory = makeInMemoryRecords(EXPORT_HAP_ID)
  await memory.records.declare({ 'hap-bridges': hapBridgesKind })
  const handle = memory.records.kind(hapBridgesKind)
  if (recordName !== null) {
    await handle.put(
      {
        id: HAP_DEFAULT_INSTANCE_ID,
        data: {
          name: recordName,
          username: 'AA:BB:CC:11:22:33',
          uuid: 'u-1',
          pincode: '246-80-135',
        },
      },
      { ifRev: 0 },
    )
  }
  const cleared: string[] = []
  const ports = (rows: SettingsRows): HapCataloguePorts => ({
    readStored: rows.readStored,
    storeFixedPin: async () => undefined,
    readLegacyIdentity: async () => null,
    clearLegacyIdentity: async () => undefined,
    putDefaultRecord: async () => 'exists',
    putExposure: async () => 'exists',
    readExposure: async () => null,
    readBridgeName: async () => {
      const name = (await rows.readStored(['bridgeName']))['bridgeName']
      return typeof name === 'string' ? name : ''
    },
    readDefaultRecord: async () =>
      (await handle.getResolved(HAP_DEFAULT_INSTANCE_ID))?.data ?? null,
    patchDefaultName: async (name) => {
      await handle.patch(HAP_DEFAULT_INSTANCE_ID, { name })
    },
    // The addon clears through `clearSecrets`: the keychain value and the row go together.
    clearFixedPin: async () => {
      const stored = (await rows.readStored(['fixedPin']))['fixedPin']
      if (typeof stored === 'object' && stored !== null) {
        vault.delete(String(Reflect.get(stored, '$secret')))
      }
      rows.remove('fixedPin')
      cleared.push('fixedPin')
    },
  })
  const fixture = settingsFixture<HapCataloguePorts>({
    addonId: EXPORT_HAP_ID,
    catalogue: ADDON_MIGRATIONS,
    seed,
    neighbour: NEIGHBOUR,
    ports,
  })
  return {
    cleared,
    fixture,
    record: async () => {
      const row = await handle.getResolved(HAP_DEFAULT_INSTANCE_ID)
      return row === null ? null : { name: row.data.name, pincode: row.data.pincode }
    },
  }
}

describe('bridge-name-to-instance (seq 6)', () => {
  it('renames the default record to the stored installation name, leaving the setup code', async () => {
    const w = await world({ bridgeName: 'Casa' }, 'CamStack Bridge')
    const report = await w.fixture.boot()
    expect(report.failed).toEqual([])
    expect(report.applied).toContain(BRIDGE_NAME_TO_INSTANCE_ID)
    expect(await w.record()).toEqual({ name: 'Casa', pincode: '246-80-135' })
  })

  it('does nothing without a stored name or without a record', async () => {
    const noName = await world({ interfaceName: 'en0' }, 'Kept')
    await noName.fixture.boot()
    expect((await noName.record())?.name).toBe('Kept')
    const noRecord = await world({ bridgeName: 'Casa' }, null)
    expect((await noRecord.fixture.boot()).failed).toEqual([])
    expect(await noRecord.record()).toBeNull()
  })
})

describe('drop-global-knobs (seq 7 and 8)', () => {
  it('releases the fixed setup code and deletes the three retired rows, keeping the node row and the neighbour', async () => {
    const vault = new Map([['ref-1', '123-45-678']])
    const w = await world(
      {
        bridgeName: 'Casa',
        fixedPin: { $secret: 'ref-1' },
        interfaceName: 'en0',
        'interfaceName@hub': 'en0',
      },
      'CamStack Bridge',
      vault,
    )
    const report = await w.fixture.boot()
    expect(report.failed).toEqual([])
    expect(report.applied).toEqual(
      expect.arrayContaining([DROP_GLOBAL_KNOBS_ID, DROP_GLOBAL_KNOB_ROWS_ID]),
    )
    const rows = w.fixture.rows()
    expect(w.cleared).toEqual(['fixedPin'])
    expect(vault.size).toBe(0)
    expect(rows['export-hap.bridgeName']).toBeUndefined()
    expect(rows['export-hap.fixedPin']).toBeUndefined()
    expect(rows['export-hap.interfaceName']).toBeUndefined()
    expect(rows['export-hap.interfaceName@hub']?.['value']).toBe('en0')
    expect(rows['other-addon.bridgeName']?.['value']).toBe(NEIGHBOUR)
    expect(rows['other-addon.interfaceName']?.['value']).toBe(NEIGHBOUR)
    expect((await w.record())?.name).toBe('Casa')
  })

  it('never deletes the cluster interfaceName when no node row carries the value', async () => {
    const w = await world({ interfaceName: 'en0' }, 'CamStack Bridge')
    await w.fixture.boot()
    // the per-node copy migration runs first and gives the hub its row, so the bare one may go
    expect(w.fixture.rows()['export-hap.interfaceName@hub']?.['value']).toBe('en0')
  })

  it('a rerun changes nothing', async () => {
    const w = await world(
      {
        bridgeName: 'Casa',
        fixedPin: { $secret: 'ref-1' },
        interfaceName: 'en0',
      },
      'CamStack Bridge',
      new Map([['ref-1', '123-45-678']]),
    )
    await w.fixture.boot()
    const first = JSON.stringify(w.fixture.rows())
    await w.fixture.boot()
    expect(JSON.stringify(w.fixture.rows())).toBe(first)
    expect(w.cleared).toEqual(['fixedPin'])
  })
})
