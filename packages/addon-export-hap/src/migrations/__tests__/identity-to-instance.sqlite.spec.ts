/**
 * The HomeKit bridge identity moves into the default instance record on real SQLite rows (the
 * canonical `addon-settings` layout) through the real runner. What a paired controller knows the
 * bridge by (username, uuid, setup code, pairing directory) must be BYTE-IDENTICAL after the move,
 * the old copy stays for a release, and a rerun changes nothing.
 */
import {
  makeInMemoryRecords,
  mergeSecretStatePaths,
  type SecretsAccess,
  transformSecretWrite,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type SettingsRows,
  settingsFixture,
} from '../../../../system/src/builtins/sqlite-storage/__tests__/support/addon-settings-fixture.js'
import {
  HAP_DEFAULT_INSTANCE_ID,
  HAP_DEFAULT_PERSIST_DIR,
  hapBridgesKind,
} from '../../hap-instance-kinds.js'
import {
  ADDON_MIGRATIONS,
  EXPORT_HAP_ID,
  type HapCataloguePorts,
  IDENTITY_TO_INSTANCE_ID,
  legacyIdentityOf,
} from '../index.js'

const NEIGHBOUR = 'keep-me'
const PAIRED = {
  username: 'AA:BB:CC:11:22:33',
  uuid: '6f1d6c9e-0a52-5d0b-9d2e-0b1f3a9a7e44',
  pincode: '246-80-135',
}

interface Options {
  /** The read-back answers with this pincode instead of the stored one. */
  readonly readBackPincode?: string
  readonly existing?: { readonly username: string; readonly uuid?: string }
}

async function build(seed: Record<string, unknown>, options: Options = {}) {
  const memory = makeInMemoryRecords(EXPORT_HAP_ID)
  await memory.records.declare({ 'hap-bridges': hapBridgesKind })
  const handle = memory.records.kind(hapBridgesKind)
  if (options.existing !== undefined) {
    await handle.put(
      {
        id: HAP_DEFAULT_INSTANCE_ID,
        data: {
          name: 'Mine',
          username: options.existing.username,
          uuid: options.existing.uuid ?? 'mine-uuid',
          pincode: '135-79-246',
          persistDir: 'mine-store',
        },
      },
      { ifRev: 0 },
    )
  }
  const puts: string[] = []
  const vault = new Map([['ref-pin', PAIRED.pincode]])
  const secrets: SecretsAccess = {
    owner: EXPORT_HAP_ID,
    ref: () => 'unused',
    resolve: async () => ({}),
    put: async () => 1,
    delete: async (refs) => refs.filter((ref) => vault.delete(ref)).length,
    state: async () => {
      throw new Error('unused')
    },
    onChange: () => () => undefined,
    forOwner: null,
  }
  const ports = (rows: SettingsRows): HapCataloguePorts => ({
    readStored: rows.readStored,
    storeFixedPin: async () => undefined,
    readLegacyIdentity: async () => {
      const stored = (await rows.readStored(['identity']))['identity']
      if (typeof stored !== 'object' || stored === null) return null
      const marker: unknown = Reflect.get(stored, 'pincode')
      const ref =
        typeof marker === 'object' && marker !== null
          ? String(Reflect.get(marker, '$secret'))
          : null
      return legacyIdentityOf({
        ...stored,
        pincode: ref === null ? marker : vault.get(ref),
      })
    },
    // The addon clears through the real settings secret writer: `identity: null` releases the
    // keychain entry its marker named. The spec runs that same writer over the stored row.
    clearLegacyIdentity: async () => {
      const stored = (await rows.readStored(['identity']))['identity']
      const { patch, afterWrite } = await transformSecretWrite({
        tree: mergeSecretStatePaths(new Map(), ['identity.pincode']),
        secrets,
        patch: { identity: null },
        stored: { identity: stored },
        operatorWrite: true,
      })
      rows.write('identity', patch['identity'])
      await afterWrite()
    },
    readBridgeName: async () => {
      const name = (await rows.readStored(['bridgeName']))['bridgeName']
      return typeof name === 'string' ? name : ''
    },
    putDefaultRecord: async (body) => {
      if ((await handle.get(HAP_DEFAULT_INSTANCE_ID)) !== null) return 'exists'
      puts.push(body.username)
      await handle.put({ id: HAP_DEFAULT_INSTANCE_ID, data: body }, { ifRev: 0 })
      return 'created'
    },
    readDefaultRecord: async () => {
      const row = await handle.getResolved(HAP_DEFAULT_INSTANCE_ID)
      if (row === null) return null
      return options.readBackPincode === undefined
        ? row.data
        : { ...row.data, pincode: options.readBackPincode }
    },
  })
  const fixture = settingsFixture<HapCataloguePorts>({
    addonId: EXPORT_HAP_ID,
    catalogue: ADDON_MIGRATIONS,
    seed,
    neighbour: NEIGHBOUR,
    ports,
  })
  return { fixture, handle, puts, vault }
}

const PAIRED_SEED = {
  bridgeName: 'Home bridge',
  identity: {
    username: PAIRED.username,
    uuid: PAIRED.uuid,
    pincode: { $secret: 'ref-pin' },
  },
}

describe('export-hap identity -> default instance', () => {
  it('adopts the paired identity byte for byte and clears the old row, keeping the neighbour', async () => {
    const { fixture, handle, vault } = await build(PAIRED_SEED)
    const report = await fixture.boot()
    expect(report.failed).toEqual([])
    expect(report.applied).toContain(IDENTITY_TO_INSTANCE_ID)
    const row = await handle.getResolved(HAP_DEFAULT_INSTANCE_ID)
    expect(row?.data).toEqual({
      name: 'Home bridge',
      username: PAIRED.username,
      uuid: PAIRED.uuid,
      pincode: PAIRED.pincode,
      persistDir: HAP_DEFAULT_PERSIST_DIR,
    })
    const rows = fixture.rows()
    // The old row holds nothing, and the keychain entry its marker named is gone...
    expect(rows['export-hap.identity']?.['value']).toBeNull()
    expect(JSON.stringify(rows)).not.toContain('ref-pin')
    expect(vault.has('ref-pin')).toBe(false)
    // ...while the record still resolves the setup code, and the marked neighbour is untouched.
    expect((await handle.getResolved(HAP_DEFAULT_INSTANCE_ID))?.data.pincode).toBe(PAIRED.pincode)
    expect(rows['other-addon.identity']?.['value']).toBe(NEIGHBOUR)
  })

  it('a second run changes nothing and writes no second record', async () => {
    const { fixture, handle, puts } = await build(PAIRED_SEED)
    await fixture.boot()
    const first = await handle.get(HAP_DEFAULT_INSTANCE_ID)
    await fixture.boot()
    expect(await handle.get(HAP_DEFAULT_INSTANCE_ID)).toEqual(first)
    expect(puts).toEqual([PAIRED.username])
  })

  it('never overwrites a record that is already there, and fails when it is another bridge', async () => {
    const { fixture, handle, puts } = await build(PAIRED_SEED, {
      existing: { username: 'DE:AD:BE:EF:00:01' },
    })
    expect((await fixture.boot()).failed).toContain(IDENTITY_TO_INSTANCE_ID)
    expect(puts).toEqual([])
    expect((await handle.get(HAP_DEFAULT_INSTANCE_ID))?.data.username).toBe('DE:AD:BE:EF:00:01')
    expect(fixture.rows()['export-hap.identity']?.['value']).toEqual(PAIRED_SEED.identity)
  })

  it('clears the leftover old identity of an interrupted pass whose record names the same bridge', async () => {
    const { fixture, vault } = await build(PAIRED_SEED, {
      existing: { username: PAIRED.username, uuid: PAIRED.uuid },
    })
    expect((await fixture.boot()).failed).toEqual([])
    expect(fixture.rows()['export-hap.identity']?.['value']).toBeNull()
    expect(vault.has('ref-pin')).toBe(false)
  })

  it('mints nothing when no complete identity was ever stored', async () => {
    const empty = await build({
      bridgeName: 'Home bridge',
      identity: { username: '', uuid: '' },
    })
    expect((await empty.fixture.boot()).failed).toEqual([])
    expect(await empty.handle.get(HAP_DEFAULT_INSTANCE_ID)).toBeNull()
    const absent = await build({ bridgeName: 'Home bridge' })
    expect((await absent.fixture.boot()).failed).toEqual([])
    expect(await absent.handle.get(HAP_DEFAULT_INSTANCE_ID)).toBeNull()
  })

  it('fails, and leaves the old copy, when the record does not read back as the identity', async () => {
    const { fixture } = await build(PAIRED_SEED, {
      readBackPincode: '000-11-222',
    })
    const report = await fixture.boot()
    expect(report.failed).toContain(IDENTITY_TO_INSTANCE_ID)
    expect(fixture.rows()['export-hap.identity']?.['value']).toEqual(PAIRED_SEED.identity)
  })
})
