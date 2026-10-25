import { describe, it, expect } from 'vitest'
import { DefaultsStore } from '../defaults-store.js'
import { makeAiRecords } from './support/fake-records.js'

async function newStore() {
  const world = await makeAiRecords()
  return { world, store: DefaultsStore.of(world.records) }
}

describe('DefaultsStore', () => {
  it('sets and lists a consumer default', async () => {
    const { store } = await newStore()
    await store.set({ consumer: 'ai-summary' }, 'p1')
    const rows = await store.list()
    expect(rows).toEqual([{ selector: { consumer: 'ai-summary' }, profileId: 'p1' }])
  })

  it('set on an existing selector key updates in place', async () => {
    const { store, world } = await newStore()
    await store.set({ purpose: 'text' }, 'p1')
    await store.set({ purpose: 'text' }, 'p2')
    const rows = await store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.profileId).toBe('p2')
    expect(world.tables.get('llm-defaults')?.size).toBe(1)
    expect(world.tables.get('llm-defaults')?.get('purpose:text')?.rev).toBe(2)
  })

  it('set(selector, null) removes the row', async () => {
    const { store } = await newStore()
    await store.set({ purpose: 'vision' }, 'p1')
    await store.set({ purpose: 'vision' }, null)
    expect(await store.list()).toEqual([])
  })

  it('drops rows that no longer validate', async () => {
    const { store, world } = await newStore()
    world.seed('llm-defaults', { id: 'bad', data: { selector: { nope: 1 }, profileId: 5 } })
    expect(await store.list()).toEqual([])
  })

  it('consumer and purpose defaults coexist as distinct keys', async () => {
    const { store } = await newStore()
    await store.set({ consumer: 'c' }, 'p1')
    await store.set({ purpose: 'text' }, 'p2')
    expect(await store.list()).toHaveLength(2)
  })
})
