/**
 * The HomeKit exposure lists (`exposed`, `exposedActions`) move into the default
 * `hap-bridge-exports` record on real SQLite rows (the canonical `addon-settings` layout) through
 * the real runner. The lists must read back IDENTICAL (a marked per-device field survives), the
 * old keys go only after that read-back, a rerun changes nothing, and a failure keeps the keys.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { settingsFixture } from '../../../../system/src/builtins/sqlite-storage/__tests__/support/addon-settings-fixture.js'
import { type HapBridgeExportsBody, hapBridgeExportsKind } from '../../hap-export-records.js'
import { HAP_DEFAULT_INSTANCE_ID } from '../../hap-instance-kinds.js'
import {
  ADDON_MIGRATIONS,
  DROP_EXPOSURE_KEYS_ID,
  EXPORT_HAP_ID,
  EXPOSURE_TO_RECORD_ID,
  type HapCataloguePorts,
} from '../index.js'

const NEIGHBOUR = 'keep-me'

const DEVICES = [
  {
    deviceId: '41',
    displayName: 'Mark-7 gate camera',
    mapperKind: 'camera',
    capabilities: ['camera', 'motion'],
    childAccessoryUuids: ['uuid-a', 'uuid-b'],
    addedAt: 1760000000000,
    settings: {
      streamPreference: 'low',
      keepClips: false,
      clipRetentionDays: 9,
    },
  },
  { deviceId: '52', displayName: 'Hall switch', mapperKind: 'generic' },
]
const ACTIONS = [{ actionId: 'act-1', displayName: 'Open gate', addedAt: 1760000001000 }]
const SEED = { bridgeName: 'Home', exposed: DEVICES, exposedActions: ACTIONS }

interface Options {
  /** The read-back answers with this body instead of the stored one. */
  readonly readBack?: HapBridgeExportsBody
  readonly existing?: HapBridgeExportsBody
}

async function build(seed: Record<string, unknown>, options: Options = {}) {
  const memory = makeInMemoryRecords(EXPORT_HAP_ID)
  await memory.records.declare({ 'hap-bridge-exports': hapBridgeExportsKind })
  const handle = memory.records.kind(hapBridgeExportsKind)
  if (options.existing !== undefined) {
    await handle.put({ id: HAP_DEFAULT_INSTANCE_ID, data: options.existing }, { ifRev: 0 })
  }
  let puts = 0
  const fixture = settingsFixture<HapCataloguePorts>({
    addonId: EXPORT_HAP_ID,
    catalogue: ADDON_MIGRATIONS,
    seed,
    neighbour: NEIGHBOUR,
    ports: (rows) => ({
      readStored: rows.readStored,
      storeFixedPin: async () => undefined,
      readLegacyIdentity: async () => null,
      readBridgeName: async () => '',
      putDefaultRecord: async () => 'exists',
      readDefaultRecord: async () => null,
      clearLegacyIdentity: async () => undefined,
      patchDefaultName: async () => undefined,
      clearFixedPin: async () => undefined,
      putExposure: async (body) => {
        if ((await handle.get(HAP_DEFAULT_INSTANCE_ID)) !== null) return 'exists'
        puts += 1
        await handle.put({ id: HAP_DEFAULT_INSTANCE_ID, data: body }, { ifRev: 0 })
        return 'created'
      },
      readExposure: async () =>
        options.readBack ?? (await handle.get(HAP_DEFAULT_INSTANCE_ID))?.data ?? null,
    }),
  })
  return { fixture, handle, puts: () => puts }
}

describe('export-hap exposure -> hap-bridge-exports record', () => {
  it('moves the lists unchanged, then deletes the old keys and keeps the neighbour', async () => {
    const { fixture, handle } = await build(SEED)
    const report = await fixture.boot()
    expect(report.failed).toEqual([])
    expect(report.applied).toEqual(
      expect.arrayContaining([EXPOSURE_TO_RECORD_ID, DROP_EXPOSURE_KEYS_ID]),
    )
    const row = await handle.get(HAP_DEFAULT_INSTANCE_ID)
    expect(row?.data.devices).toEqual(DEVICES)
    expect(row?.data.actions).toEqual(ACTIONS)
    const rows = fixture.rows()
    expect(rows['export-hap.exposed']).toBeUndefined()
    expect(rows['export-hap.exposedActions']).toBeUndefined()
    // the retired global knob is deleted by seq 8 once the name has moved
    expect(rows['export-hap.bridgeName']).toBeUndefined()
    expect(rows['other-addon.exposed']?.['value']).toBe(NEIGHBOUR)
  })

  it('a second run changes nothing and writes no second record', async () => {
    const { fixture, handle, puts } = await build(SEED)
    await fixture.boot()
    const first = await handle.get(HAP_DEFAULT_INSTANCE_ID)
    expect((await fixture.boot()).failed).toEqual([])
    expect(await handle.get(HAP_DEFAULT_INSTANCE_ID)).toEqual(first)
    expect(puts()).toBe(1)
  })

  it('a read-back that differs fails the pass and keeps the old keys', async () => {
    const { fixture } = await build(SEED, {
      readBack: { name: 'HomeKit exposure', devices: [], actions: ACTIONS },
    })
    expect((await fixture.boot()).failed).toContain(EXPOSURE_TO_RECORD_ID)
    const rows = fixture.rows()
    expect(rows['export-hap.exposed']?.['value']).toEqual(DEVICES)
    expect(rows['export-hap.exposedActions']?.['value']).toEqual(ACTIONS)
  })

  it('keeps the old keys when the record already holds other lists', async () => {
    const { fixture, handle, puts } = await build(SEED, {
      existing: { name: 'HomeKit exposure', devices: [], actions: [] },
    })
    expect((await fixture.boot()).failed).toEqual([])
    expect(puts()).toBe(0)
    expect((await handle.get(HAP_DEFAULT_INSTANCE_ID))?.data.devices).toEqual([])
    expect(fixture.rows()['export-hap.exposed']?.['value']).toEqual(DEVICES)
  })

  it('moves nothing when no list was ever stored', async () => {
    const { fixture, handle } = await build({ bridgeName: 'Home' })
    expect((await fixture.boot()).failed).toEqual([])
    expect(await handle.get(HAP_DEFAULT_INSTANCE_ID)).toBeNull()
  })
})
