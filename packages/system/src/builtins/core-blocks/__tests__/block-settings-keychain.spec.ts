/**
 * D880 - a password a user script declares is stored in the keychain, in ONE
 * place (the block addon's `addon-settings` rows), and moved by a verified
 * operator migration. Every value below is fabricated.
 */
import {
  buildSecretRef,
  type ConfigUISchema,
  coreBlockAddonId,
  isSecretMarker,
  type KeychainResolveResult,
  makeSecretMarker,
  REDACTED_SECRET,
  type SecretScope,
  type SecretsAccess,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { BlockSecretsUnavailableError } from '../block-settings-store.js'
import { blockSettingsStoreHarness, fakeSettingsStore } from './fixtures.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'

const PASSWORD = 'fake-pass-0001'
const NEXT_PASSWORD = 'fake-pass-0002'

const SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'main',
      title: 'Main',
      fields: [
        { type: 'text', key: 'host', label: 'Host' },
        { type: 'password', key: 'password', label: 'Password' },
      ],
    },
  ],
}

interface SharedKeychain {
  readonly values: Map<string, string>
  readonly keychainFor: (owner: string) => SecretsAccess
  setLocked(locked: boolean): void
  /** The next resolve answers a DIFFERENT value: a keychain that did not store what it was given. */
  setLying(lying: boolean): void
}

function sharedKeychain(): SharedKeychain {
  const values = new Map<string, string>()
  let locked = false
  let lying = false
  const keychainFor = (owner: string): SecretsAccess => ({
    owner,
    ref: (scope: SecretScope, fieldPath: string) => buildSecretRef({ owner, scope, fieldPath }),
    resolve: async (refs) => {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const value = values.get(ref)
        out[ref] = locked
          ? { kind: 'unavailable', reason: 'key-missing' }
          : value === undefined
            ? { kind: 'missing' }
            : { kind: 'value', value: lying ? `${value}-x` : value, version: 1 }
      }
      return out
    },
    put: async (ref, value) => {
      if (locked) throw new Error('keychain locked')
      values.set(ref, value)
      return 1
    },
    delete: async (refs) => {
      let deleted = 0
      for (const ref of refs) if (values.delete(ref)) deleted += 1
      return deleted
    },
    state: async () => (locked ? { state: 'locked', reason: 'key-missing' } : { state: 'ready' }),
    onChange: () => () => undefined,
    forOwner: null,
  })
  return {
    values,
    keychainFor,
    setLocked: (next) => {
      locked = next
    },
    setLying: (next) => {
      lying = next
    },
  }
}

async function setup() {
  const settings = fakeSettingsStore()
  const keychain = sharedKeychain()
  const harness = await blockSettingsStoreHarness(keychain.keychainFor, settings)
  return { settings, keychain, store: harness.prefs, records: harness.records }
}

async function seedLegacy(
  records: Awaited<ReturnType<typeof setup>>['records'],
  blockId: string,
  values: Record<string, unknown>,
): Promise<void> {
  await records.kind(coreBlocksRecordKinds.settings).put({ id: blockId, data: { values } })
}

function rowOf(rows: Map<string, Record<string, unknown>>, blockId: string, key: string) {
  return rows.get(`${coreBlockAddonId(blockId)}.${key}`)?.['value']
}

const ownRef = (blockId: string, key: string): string =>
  buildSecretRef({
    owner: coreBlockAddonId(blockId),
    scope: { kind: 'global' },
    fieldPath: key,
  })

describe('a block password is keychain-backed', () => {
  it('stores a marker in the row and the value in the keychain, never the value in a row', async () => {
    const { settings, keychain, store } = await setup()
    await store.mergeValues('b1', SCHEMA, { host: 'lan', password: PASSWORD })
    const stored = rowOf(settings.addonRows, 'b1', 'password')
    expect(isSecretMarker(stored)).toBe(true)
    expect(rowOf(settings.addonRows, 'b1', 'host')).toBe('lan')
    expect(JSON.stringify([...settings.addonRows.values()])).not.toContain(PASSWORD)
    expect(JSON.stringify([...settings.rows.values()])).not.toContain(PASSWORD)
    expect(keychain.values.get(ownRef('b1', 'password'))).toBe(PASSWORD)
  })

  it('a REDACTED or "set" view write keeps the stored value', async () => {
    const { settings, keychain, store } = await setup()
    await store.mergeValues('b1', SCHEMA, { password: PASSWORD })
    await store.mergeValues('b1', SCHEMA, { host: 'lan', password: REDACTED_SECRET })
    await store.mergeValues('b1', SCHEMA, { password: { $secret: null, v: 1, set: true } })
    expect(isSecretMarker(rowOf(settings.addonRows, 'b1', 'password'))).toBe(true)
    expect(keychain.values.get(ownRef('b1', 'password'))).toBe(PASSWORD)
  })

  it('a marker pointing at ANOTHER block is never stored', async () => {
    const { settings, keychain, store } = await setup()
    await store.mergeValues('victim', SCHEMA, { password: PASSWORD })
    await store.mergeValues('b1', SCHEMA, {
      password: makeSecretMarker(ownRef('victim', 'password')),
    })
    expect(rowOf(settings.addonRows, 'b1', 'password')).toBeUndefined()
    expect(keychain.values.size).toBe(1)
  })

  it('a new value replaces the old one in place', async () => {
    const { keychain, store } = await setup()
    await store.mergeValues('b1', SCHEMA, { password: PASSWORD })
    await store.mergeValues('b1', SCHEMA, { password: NEXT_PASSWORD })
    expect([...keychain.values.values()]).toEqual([NEXT_PASSWORD])
  })

  it('a locked keychain refuses the save and writes nothing', async () => {
    const { settings, keychain, store } = await setup()
    keychain.setLocked(true)
    await expect(store.mergeValues('b1', SCHEMA, { password: PASSWORD })).rejects.toThrow()
    expect(settings.addonRows.size).toBe(0)
  })

  it('no keychain door refuses a block that declares a password, rather than storing it', async () => {
    const settings = fakeSettingsStore()
    const { prefs: store } = await blockSettingsStoreHarness(() => null, settings)
    await expect(store.mergeValues('b1', SCHEMA, { password: PASSWORD })).rejects.toBeInstanceOf(
      BlockSecretsUnavailableError,
    )
    expect(settings.addonRows.size).toBe(0)
  })

  it('a block with no schema stores its values as sent (nothing is declared secret)', async () => {
    const { settings, store } = await setup()
    await store.mergeValues('b1', undefined, { password: 'not-declared' })
    expect(rowOf(settings.addonRows, 'b1', 'password')).toBe('not-declared')
  })

  it('deleting the block removes its rows, its keychain values and the legacy copy', async () => {
    const { settings, keychain, store, records } = await setup()
    await store.mergeValues('b1', SCHEMA, { host: 'lan', password: PASSWORD })
    await seedLegacy(records, 'b1', { password: PASSWORD })
    await store.delete('b1')
    expect(settings.addonRows.size).toBe(0)
    expect(keychain.values.size).toBe(0)
    expect(await records.kind(coreBlocksRecordKinds.settings).get('b1')).toBeNull()
  })
})

describe('migrateRawSecrets', () => {
  const blocks = [{ id: 'b1', settingsSchema: SCHEMA }]

  async function seedRaw(
    records: Awaited<ReturnType<typeof setup>>['records'],
    settings: ReturnType<typeof fakeSettingsStore>,
  ): Promise<void> {
    await seedLegacy(records, 'b1', {
      host: 'lan',
      password: PASSWORD,
      extra: 'only-legacy',
    })
    settings.addonRows.set(`${coreBlockAddonId('b1')}.host`, {
      addonId: coreBlockAddonId('b1'),
      key: 'host',
      value: 'lan',
    })
    settings.addonRows.set(`${coreBlockAddonId('b1')}.password`, {
      addonId: coreBlockAddonId('b1'),
      key: 'password',
      value: PASSWORD,
    })
  }

  it('a dry run changes nothing and reports counts', async () => {
    const { settings, keychain, store, records } = await setup()
    await seedRaw(records, settings)
    const report = await store.migrateRawSecrets(blocks, false)
    expect(report).toMatchObject({ rows: 1, raw: 1, migrated: 0, redundantCopies: 1 })
    expect(report.verified).toBe(false)
    expect(rowOf(settings.addonRows, 'b1', 'password')).toBe(PASSWORD)
    expect(await records.kind(coreBlocksRecordKinds.settings).get('b1')).not.toBeNull()
    expect(keychain.values.size).toBe(0)
  })

  it('apply moves the secret, keeps one copy and verifies', async () => {
    const { settings, keychain, store, records } = await setup()
    await seedRaw(records, settings)
    const report = await store.migrateRawSecrets(blocks, true)
    expect(report).toMatchObject({ migrated: 1, failed: 0, remainingRaw: 0, unresolvedMarkers: 0 })
    expect(report.verified).toBe(true)
    expect(isSecretMarker(rowOf(settings.addonRows, 'b1', 'password'))).toBe(true)
    expect(rowOf(settings.addonRows, 'b1', 'extra')).toBe('only-legacy')
    expect(keychain.values.get(ownRef('b1', 'password'))).toBe(PASSWORD)
    expect(await records.kind(coreBlocksRecordKinds.settings).get('b1')).toBeNull()
    expect(JSON.stringify([...settings.addonRows.values()])).not.toContain(PASSWORD)
  })

  it('is idempotent: a second apply finds nothing raw', async () => {
    const { settings, store, records } = await setup()
    await seedRaw(records, settings)
    await store.migrateRawSecrets(blocks, true)
    const again = await store.migrateRawSecrets(blocks, true)
    expect(again).toMatchObject({ raw: 0, markers: 1, migrated: 0, failed: 0, verified: true })
  })

  it('a keychain that does not return what it stored leaves the block raw and untouched', async () => {
    const { settings, keychain, store, records } = await setup()
    await seedRaw(records, settings)
    keychain.setLying(true)
    const report = await store.migrateRawSecrets(blocks, true)
    expect(report).toMatchObject({ migrated: 0, failed: 1, verified: false })
    expect(rowOf(settings.addonRows, 'b1', 'password')).toBe(PASSWORD)
    expect(await records.kind(coreBlocksRecordKinds.settings).get('b1')).not.toBeNull()
    expect(keychain.values.size).toBe(0)
  })

  it('a locked keychain leaves the block raw and untouched', async () => {
    const { settings, keychain, store, records } = await setup()
    await seedRaw(records, settings)
    keychain.setLocked(true)
    const report = await store.migrateRawSecrets(blocks, true)
    expect(report).toMatchObject({ migrated: 0, failed: 1, verified: false })
    expect(rowOf(settings.addonRows, 'b1', 'password')).toBe(PASSWORD)
    expect(await records.kind(coreBlocksRecordKinds.settings).get('b1')).not.toBeNull()
  })

  it('a legacy copy of a block that no longer exists is removed', async () => {
    const { store, records } = await setup()
    await seedLegacy(records, 'gone', { password: PASSWORD })
    const report = await store.migrateRawSecrets(blocks, true)
    expect(await records.kind(coreBlocksRecordKinds.settings).get('gone')).toBeNull()
    expect(report.redundantCopies).toBe(1)
  })

  it('a credential-named key the schema does not declare is never copied, flagged unverified, and its legacy blob stays', async () => {
    const { settings, store, records } = await setup()
    await seedLegacy(records, 'b2', { host: 'lan', apiToken: PASSWORD })
    const report = await store.migrateRawSecrets([{ id: 'b2' }], true)
    expect(report).toMatchObject({ raw: 1, verified: false })
    expect(report.remainingRaw).toBeGreaterThan(0)
    expect(JSON.stringify([...settings.addonRows.values()])).not.toContain(PASSWORD)
    expect(rowOf(settings.addonRows, 'b2', 'host')).toBe('lan')
    expect(await records.kind(coreBlocksRecordKinds.settings).get('b2')).not.toBeNull()
  })

  it('the same holds for a PARTIAL schema: the undeclared credential stays flagged', async () => {
    const { settings, store, records } = await setup()
    await seedLegacy(records, 'b1', { password: PASSWORD, otherSecret: NEXT_PASSWORD })
    const report = await store.migrateRawSecrets(blocks, true)
    expect(report.verified).toBe(false)
    expect(isSecretMarker(rowOf(settings.addonRows, 'b1', 'password'))).toBe(true)
    expect(rowOf(settings.addonRows, 'b1', 'otherSecret')).toBeUndefined()
    expect(await records.kind(coreBlocksRecordKinds.settings).get('b1')).not.toBeNull()
  })

  it('a legacy marker that points at ANOTHER owner is dropped and reported, not copied', async () => {
    const { settings, store, records } = await setup()
    await seedLegacy(records, 'b2', {
      host: 'lan',
      stolen: makeSecretMarker(ownRef('victim', 'password')),
    })
    const report = await store.migrateRawSecrets([{ id: 'b2' }], true)
    expect(report.failed).toBe(1)
    expect(rowOf(settings.addonRows, 'b2', 'stolen')).toBeUndefined()
    expect(rowOf(settings.addonRows, 'b2', 'host')).toBe('lan')
  })

  it("a legacy marker of the block's own ref is carried over", async () => {
    const { settings, store, records } = await setup()
    const own = makeSecretMarker(ownRef('b2', 'token'))
    await seedLegacy(records, 'b2', { sess: own })
    await store.migrateRawSecrets([{ id: 'b2' }], true)
    expect(rowOf(settings.addonRows, 'b2', 'sess')).toEqual(own)
  })

  it('the report carries counts only', async () => {
    const { settings, store, records } = await setup()
    await seedRaw(records, settings)
    const report = await store.migrateRawSecrets(blocks, true)
    expect(JSON.stringify(report)).not.toContain(PASSWORD)
    expect(JSON.stringify(report)).not.toContain('b1')
  })
})
