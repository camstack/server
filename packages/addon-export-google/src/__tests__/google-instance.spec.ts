/**
 * The instance registry loads an instance's links BEFORE serving it: a SYNC that arrives while the
 * read is still in flight must wait for it, or it would write an empty ledger over the real one.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { ActionSceneExports } from '../action-scenes.js'
import {
  EMPTY_GOOGLE_EXPORTS,
  GOOGLE_INSTANCE_ID,
  googleExportsKind,
  googleHomesKind,
  googleLinksKind,
} from '../export-records.js'
import { GoogleInstanceRegistry, type GoogleInstanceStores } from '../google-instance.js'
import { createFakeGateway, RecordingLogger } from './fakes.js'

const LINK_A = { userId: 'user-a', username: 'ann', linkedAt: 1700000000000 }
const CALLER_B = { userId: 'user-b', username: 'bob', scopes: [] }

async function world() {
  const memory = makeInMemoryRecords('export-google')
  await memory.records.declare({
    'google-homes': googleHomesKind,
    'google-exports': googleExportsKind,
    'google-links': googleLinksKind,
  })
  const homes = memory.records.kind(googleHomesKind)
  const exported = memory.records.kind(googleExportsKind)
  const links = memory.records.kind(googleLinksKind)
  await homes.put({ id: GOOGLE_INSTANCE_ID, data: { name: 'Google Home' } }, { ifRev: 0 })
  await exported.put({ id: GOOGLE_INSTANCE_ID, data: EMPTY_GOOGLE_EXPORTS }, { ifRev: 0 })
  await links.put(
    { id: GOOGLE_INSTANCE_ID, data: { name: 'Google links', linkedAccounts: [LINK_A] } },
    { ifRev: 0 },
  )
  const logger = new RecordingLogger()
  const registryOver = (stores: GoogleInstanceStores) =>
    new GoogleInstanceRegistry(
      stores,
      logger,
      (persist, initial) =>
        new ActionSceneExports(
          {
            api: undefined as never,
            logger,
            isAdminUser: async () => false,
            persist,
          },
          initial,
        ),
    )
  return { memory, homes, exported, links, registryOver, gateway: createFakeGateway() }
}

describe('GoogleInstanceRegistry', () => {
  it('a SYNC during the links read waits for it and keeps the ledger', async () => {
    const w = await world()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slowLinks = Object.assign(Object.create(w.links), {
      get: async (id: string) => {
        await gate
        return w.links.get(id)
      },
    })
    const registry = w.registryOver({ homes: w.homes, exports: w.exported, links: slowLinks })

    const first = registry.get(GOOGLE_INSTANCE_ID)
    const second = registry.get(GOOGLE_INSTANCE_ID)
    // The first request of the boot: it must not be answered by an instance with no ledger.
    const sync = first.then((instance) => instance?.recordLink(CALLER_B))
    expect(registry.peek(GOOGLE_INSTANCE_ID)).toBeUndefined()
    release()
    await sync
    expect(await second).toBe(await first)
    const held = (await w.links.get(GOOGLE_INSTANCE_ID))?.data.linkedAccounts.map((a) => a.userId)
    expect(held).toEqual(['user-a', 'user-b'])
  })

  it('a failed read rejects, writes nothing, and is not cached', async () => {
    const w = await world()
    const registry = w.registryOver({ homes: w.homes, exports: w.exported, links: w.links })
    const before = await w.links.get(GOOGLE_INSTANCE_ID)
    w.memory.failReads(true)
    await expect(registry.get(GOOGLE_INSTANCE_ID)).rejects.toThrow()
    w.memory.failReads(false)
    expect(await w.links.get(GOOGLE_INSTANCE_ID)).toEqual(before)
    const instance = await registry.get(GOOGLE_INSTANCE_ID)
    expect(instance?.linkedAccounts).toEqual([LINK_A])
  })

  it('an instance that has no row is null, never an empty one', async () => {
    const w = await world()
    const registry = w.registryOver({ homes: w.homes, exports: w.exported, links: w.links })
    expect(await registry.get('missing')).toBeNull()
    expect(vi.isMockFunction(registry.get)).toBe(false)
  })
})
