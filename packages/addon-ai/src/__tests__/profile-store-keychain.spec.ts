/**
 * D878 / D879 - an LLM profile's apiKey lives in the keychain, never in the row:
 * the `llm-profiles` kind marks it `.meta({ secret: true })` and the records
 * facade does the rest. Every key below is fabricated.
 */
import {
  isSecretMarker,
  type LlmGenerateResult,
  type LlmProfile,
  recordSecretRef,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { LlmClient } from '../client/llm-client.js'
import { DefaultsStore } from '../defaults-store.js'
import { ApiKeyStorageUnavailableError, ProfileStore } from '../profile-store.js'
import { aiRecordKinds } from '../record-kinds.js'
import { createLlmProvider } from '../provider.js'
import { REDACTED_MARKER } from '../secrets.js'
import type { UsageFilter, UsageRecorder, UsageRowInput } from '../usage/usage-port.js'
import { makeAiRecords, type FakeRecords } from './support/fake-records.js'
import { makeProfile } from './support/profile.js'

const KEY = 'fake-key-0001'

function profile(id: string, overrides: Record<string, unknown> = {}): LlmProfile {
  return makeProfile({ id, name: id, ...overrides })
}

async function setup() {
  const world = await makeAiRecords()
  return { world, keychain: world.keychain, store: ProfileStore.of(world.records) }
}

function rawRow(world: FakeRecords, id: string) {
  return world.tables.get('llm-profiles')?.get(id)?.data
}

describe('the kind marks the apiKey as a secret field', () => {
  it('declares exactly apiKey as a secret path, and no engine TTL on a kind with secrets', () => {
    const decl = aiRecordKinds['llm-profiles'].declaration
    expect(decl.secretPaths).toEqual(['apiKey'])
    expect(decl.retention).toEqual({
      none: expect.any(String),
    })
  })
})

describe('ProfileStore keeps the apiKey in the keychain', () => {
  it('writes a marker to the row and the value to the keychain', async () => {
    const { world, keychain, store } = await setup()
    await store.upsert(profile('a', { apiKey: KEY }))
    const data = rawRow(world, 'a')
    expect(isSecretMarker(data?.['apiKey'])).toBe(true)
    expect(JSON.stringify(data)).not.toContain(KEY)
    expect([...keychain.values.values()]).toEqual([KEY])
    // the ref is bound to the RECORD row, not to the legacy table
    expect([...keychain.values.keys()]).toEqual([
      recordSecretRef('ai', 'llm-profiles', 'a', 'apiKey'),
    ])
  })

  it('resolves the key on read', async () => {
    const { store } = await setup()
    await store.upsert(profile('a', { apiKey: KEY }))
    expect((await store.getById('a'))?.providerConfig.apiKey).toBe(KEY)
    expect((await store.list())[0]?.providerConfig.apiKey).toBe(KEY)
  })

  it('a locked keychain refuses the save and writes nothing', async () => {
    const { world, keychain, store } = await setup()
    keychain.setLocked(true)
    await expect(store.upsert(profile('a', { apiKey: KEY }))).rejects.toBeInstanceOf(
      ApiKeyStorageUnavailableError,
    )
    expect(rawRow(world, 'a')).toBeUndefined()
  })

  it('no keychain door refuses a key rather than storing it inline', async () => {
    const world = await makeAiRecords({ keychainDoor: false })
    const store = ProfileStore.of(world.records)
    await expect(store.upsert(profile('a', { apiKey: KEY }))).rejects.toBeInstanceOf(
      ApiKeyStorageUnavailableError,
    )
    expect(rawRow(world, 'a')).toBeUndefined()
  })

  it('a locked keychain on read leaves the key off and says why', async () => {
    const { keychain, store } = await setup()
    await store.upsert(profile('a', { apiKey: KEY }))
    keychain.setLocked(true)
    const read = await store.getById('a')
    expect(read?.providerConfig.apiKey).toBeUndefined()
    expect(store.lockedReason('a')).not.toBeNull()
    expect(store.lockedReason('a') ?? '').not.toContain(KEY)
    keychain.setLocked(false)
    await store.getById('a')
    expect(store.lockedReason('a')).toBeNull()
  })

  it('a locked keychain locks only the profiles that HAVE a key, and a list still answers', async () => {
    const { keychain, store } = await setup()
    await store.upsert(profile('keyed', { apiKey: KEY }))
    await store.upsert(profile('plain'))
    keychain.setLocked(true)
    const listed = await store.list()
    expect(listed.map((p) => p.id).toSorted()).toEqual(['keyed', 'plain'])
    expect(listed.find((p) => p.id === 'keyed')?.providerConfig.apiKey).toBeUndefined()
    expect(store.lockedReason('keyed')).not.toBeNull()
    expect(store.lockedReason('plain')).toBeNull()
  })

  it('removing the key drops the keychain value; deleting the profile too', async () => {
    const { world, keychain, store } = await setup()
    await store.upsert(profile('a', { apiKey: KEY }))
    await store.upsert(profile('a'))
    expect(keychain.values.size).toBe(0)
    expect(rawRow(world, 'a')?.['apiKey']).toBeUndefined()
    await store.upsert(profile('b', { apiKey: KEY }))
    await store.delete('b')
    expect(keychain.values.size).toBe(0)
  })

  it('keepStoredKey leaves the stored marker alone', async () => {
    const { world, keychain, store } = await setup()
    await store.upsert(profile('a', { apiKey: KEY }))
    keychain.setLocked(true)
    await store.upsert(profile('a', { name: 'renamed' }), { keepStoredKey: true })
    keychain.setLocked(false)
    expect(isSecretMarker(rawRow(world, 'a')?.['apiKey'])).toBe(true)
    expect(rawRow(world, 'a')?.['name']).toBe('renamed')
    expect((await store.getById('a'))?.providerConfig.apiKey).toBe(KEY)
  })

  it('without keepStoredKey, a save that carries no key clears the stored one', async () => {
    const { world, store } = await setup()
    await store.upsert(profile('a', { apiKey: KEY }))
    await store.upsert(profile('a', { name: 'renamed' }))
    expect(rawRow(world, 'a')?.['apiKey']).toBeUndefined()
  })
})

describe('adopted rows (the adoption wrote the marker, the operator imported the value)', () => {
  it('serves a key the adoption left bound to the record ref', async () => {
    const { world, keychain, store } = await setup()
    const ref = recordSecretRef('ai', 'llm-profiles', 'legacy', 'apiKey')
    keychain.values.set(ref, KEY)
    world.seed('llm-profiles', {
      id: 'legacy',
      data: { ...bodyOf(profile('legacy')), apiKey: { $secret: ref, v: 1 } },
    })
    expect((await store.getById('legacy'))?.providerConfig.apiKey).toBe(KEY)
  })

  it('a marker whose value was never imported is a LOCK, never an empty key', async () => {
    const { world, store } = await setup()
    const ref = recordSecretRef('ai', 'llm-profiles', 'legacy', 'apiKey')
    world.seed('llm-profiles', {
      id: 'legacy',
      data: { ...bodyOf(profile('legacy')), apiKey: { $secret: ref, v: 1 } },
    })
    expect((await store.getById('legacy'))?.providerConfig.apiKey).toBeUndefined()
    expect(store.lockedReason('legacy')).not.toBeNull()
  })

  function bodyOf(p: LlmProfile): Record<string, unknown> {
    const { id: _id, ...rest } = p
    return rest
  }
})

describe('migrateRawKeys (the D878 cap method over records)', () => {
  it('a record never holds plaintext: it reports markers and moves nothing', async () => {
    const { store } = await setup()
    await store.upsert(profile('keyed', { apiKey: KEY }))
    await store.upsert(profile('plain'))
    const report = await store.migrateRawKeys(true)
    expect(report).toMatchObject({
      apply: true,
      rows: 2,
      raw: 0,
      markers: 1,
      migrated: 0,
      failed: 0,
      remainingRaw: 0,
      unresolvedMarkers: 0,
      verified: true,
    })
  })

  it('a locked keychain is reported as unresolved, not verified', async () => {
    const { keychain, store } = await setup()
    await store.upsert(profile('keyed', { apiKey: KEY }))
    keychain.setLocked(true)
    const report = await store.migrateRawKeys(false)
    expect(report).toMatchObject({ unresolvedMarkers: 1, verified: false })
  })

  it('never puts a value in its report', async () => {
    const { store } = await setup()
    await store.upsert(profile('keyed', { apiKey: KEY }))
    expect(JSON.stringify(await store.migrateRawKeys(true))).not.toContain('fake-key')
  })
})

class NoUsage implements UsageRecorder {
  async record(_row: UsageRowInput): Promise<void> {}
  async rollup(_filter: UsageFilter): Promise<never[]> {
    return []
  }
}

function providerOver(store: ProfileStore, world: FakeRecords) {
  const calls: string[] = []
  const ok: LlmGenerateResult = {
    ok: true,
    text: 'answer',
    model: 'm',
    usage: { inputTokens: 1, outputTokens: 1 },
    truncated: false,
    latencyMs: 1,
  }
  const client: LlmClient = {
    supports: () => true,
    generate: async (request) => {
      calls.push(String(request.profile.providerConfig.apiKey ?? '<none>'))
      return ok
    },
    openStream: async () => ({ kind: 'unsupported' }),
  }
  const provider = createLlmProvider({
    store,
    defaults: DefaultsStore.of(world.records),
    client,
    usage: new NoUsage(),
  })
  return { provider, calls }
}

describe('the provider over a keychain-backed store', () => {
  it('sends the resolved key to the client', async () => {
    const { world, store } = await setup()
    await store.upsert(profile('a', { apiKey: KEY }))
    const { provider, calls } = providerOver(store, world)
    const result = await provider.generate({ consumer: 'c', profileId: 'a', prompt: 'q' })
    expect(result.ok).toBe(true)
    expect(calls).toEqual([KEY])
  })

  it('a locked keychain is an explicit failure and the call never leaves', async () => {
    const { world, keychain, store } = await setup()
    await store.upsert(profile('a', { apiKey: KEY }))
    keychain.setLocked(true)
    const { provider, calls } = providerOver(store, world)
    const result = await provider.generate({ consumer: 'c', profileId: 'a', prompt: 'q' })
    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
    expect(calls).toEqual([])
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('the wire shows a stored key as set, even while unreadable, and never the value', async () => {
    const { world, keychain, store } = await setup()
    const { provider } = providerOver(store, world)
    await provider.upsertProfile({ profile: profile('a', { apiKey: KEY }) })
    keychain.setLocked(true)
    const listed = await provider.listProfiles({})
    expect(listed[0]?.providerConfig.apiKey).toBe(REDACTED_MARKER)
    expect(JSON.stringify(listed)).not.toContain(KEY)
  })

  it('a redacted save over an unreadable key keeps the stored key', async () => {
    const { world, keychain, store } = await setup()
    const { provider } = providerOver(store, world)
    await provider.upsertProfile({ profile: profile('a', { apiKey: KEY }) })
    keychain.setLocked(true)
    await provider.listProfiles({})
    await provider.upsertProfile({ profile: profile('a', { name: 'x', apiKey: REDACTED_MARKER }) })
    keychain.setLocked(false)
    expect((await store.getById('a'))?.providerConfig.apiKey).toBe(KEY)
  })

  it('a REDACTED value on write keeps the existing secret (readable keychain)', async () => {
    const { world, store } = await setup()
    const { provider } = providerOver(store, world)
    await provider.upsertProfile({ profile: profile('a', { apiKey: KEY }) })
    await provider.upsertProfile({ profile: profile('a', { name: 'y', apiKey: REDACTED_MARKER }) })
    expect((await store.getById('a'))?.providerConfig.apiKey).toBe(KEY)
  })

  it('migrateRawSecrets is served by the provider', async () => {
    const { world, store } = await setup()
    const { provider } = providerOver(store, world)
    const report = await provider.migrateRawSecrets({ apply: false })
    expect(report).toMatchObject({ apply: false, verified: true })
  })
})
