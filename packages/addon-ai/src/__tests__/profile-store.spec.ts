import type { LlmProfile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ProfileStore, SEED_PROFILE_ID } from '../profile-store.js'
import { makeAiRecords } from './support/fake-records.js'
import { makeProfile } from './support/profile.js'

function profile(id: string, overrides: Record<string, unknown> = {}): LlmProfile {
  return makeProfile({ id, name: `p-${id}`, ...overrides })
}

async function newStore() {
  const world = await makeAiRecords()
  return { world, store: ProfileStore.of(world.records) }
}

describe('ProfileStore', () => {
  it('round-trips a profile through upsert/list/getById', async () => {
    const { store } = await newStore()
    await store.upsert(profile('a', { apiKey: 'sk-secret' }))
    expect(await store.getById('a')).toEqual(profile('a', { apiKey: 'sk-secret' }))
    expect(await store.list()).toHaveLength(1)
  })

  it('the row body does not repeat the id (the record id is the profile id)', async () => {
    const { world, store } = await newStore()
    await store.upsert(profile('a'))
    expect(world.tables.get('llm-profiles')?.get('a')?.data).not.toHaveProperty('id')
  })

  it('upsert on an existing id updates in place', async () => {
    const { world, store } = await newStore()
    await store.upsert(profile('a'))
    await store.upsert(profile('a', { name: 'renamed' }))
    const rows = await store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('renamed')
    expect(world.tables.get('llm-profiles')?.get('a')?.rev).toBe(2)
  })

  it('delete removes the row', async () => {
    const { store } = await newStore()
    await store.upsert(profile('a'))
    await store.delete('a')
    expect(await store.getById('a')).toBeNull()
  })

  it('drops rows that no longer validate against LlmProfileSchema', async () => {
    const { world, store } = await newStore()
    world.seed('llm-profiles', { id: 'bad', data: { name: 42 } })
    expect(await store.list()).toEqual([])
  })

  it('ensureSeeded inserts ONE disabled LAN-Ollama template exactly once', async () => {
    const { world, store } = await newStore()
    await store.ensureSeeded()
    await store.ensureSeeded()
    const rows = await store.list()
    expect(rows).toHaveLength(1)
    const seed = rows[0]!
    expect(seed.id).toBe(SEED_PROFILE_ID)
    expect(seed.enabled).toBe(false)
    expect(seed.kind).toBe('openai-compatible')
    expect(String(seed.providerConfig.baseUrl)).toContain(':11434/v1')
    expect(seed.providerConfig.apiKey).toBeUndefined()
    expect(world.tables.get('llm-meta')?.get('seededDefaults')?.data).toMatchObject({
      at: expect.any(Number),
    })
  })

  it('a deleted seed never re-appears (seededDefaults marker)', async () => {
    const { store } = await newStore()
    await store.ensureSeeded()
    await store.delete(SEED_PROFILE_ID)
    await store.ensureSeeded()
    expect(await store.list()).toEqual([])
  })

  it('an adopted marker row stops the seed (the adoption copies llm-meta first)', async () => {
    const { world, store } = await newStore()
    world.seed('llm-meta', { id: 'seededDefaults', data: { at: 1 } })
    await store.ensureSeeded()
    expect(await store.list()).toEqual([])
  })
})
