/**
 * The `records` capability of the engine (D881) over two real engines standing
 * in for camstack.db and events.db: the owner comes from the stamp and nothing
 * else, a kind lives in the file it declared, a declaration reads no legacy
 * table (the records migration is closed, D900), and the admin methods read
 * any owner redacted.
 */
import {
  type DataStoreDatabase,
  DeclarationRefusedError,
  NoCallerError,
  UnknownRecordKindError,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RecordsEngine } from '../records/records-engine.js'
import { RecordsProvider } from '../records/records-provider.js'
import type { PlacementRouter } from '../placement-router.js'
import { declaration, silentLogger } from './support/records-harness.js'
import { FakeFile, makeRecordsWorld } from './support/records-world.js'

function makeProvider(): {
  provider: RecordsProvider
  settings: FakeFile
  events: FakeFile
} {
  const world = makeRecordsWorld()
  return {
    provider: world.provider,
    settings: world.settings,
    events: world.events,
  }
}

const stamped = <T extends object>(owner: string, input: T): T & { callerAddonId: string } => ({
  ...input,
  callerAddonId: owner,
})

describe('records provider', () => {
  it('refuses a call that carries no caller stamp', async () => {
    const { provider } = makeProvider()
    await expect(provider.get({ kind: 'x', id: 'a' })).rejects.toBeInstanceOf(NoCallerError)
    const blank = { kind: 'x', id: 'a', callerAddonId: '' }
    await expect(provider.get(blank)).rejects.toBeInstanceOf(NoCallerError)
  })

  it('places a kind in the file it declares and serves it only to its owner', async () => {
    const { provider, settings, events } = makeProvider()
    await provider.declareKinds(
      stamped('a', {
        kinds: {
          cfg: declaration({ device: 'none', at: 'none', class: 'config' }),
          ev: declaration({ database: 'events' }),
        },
      }),
    )
    await provider.put(stamped('a', { kind: 'cfg', record: { id: '1', data: { v: 1 } } }))
    await provider.put(
      stamped('a', {
        kind: 'ev',
        record: { id: '1', deviceId: 3, at: 5, data: { v: 2 } },
      }),
    )
    expect((await settings.engine.listKinds({})).map((k) => k.kind)).toEqual(['cfg'])
    expect((await events.engine.listKinds({})).map((k) => k.kind)).toEqual(['ev'])
    expect(await provider.get(stamped('a', { kind: 'ev', id: '1' }))).toMatchObject({
      data: { v: 2 },
    })
    await expect(provider.get(stamped('b', { kind: 'ev', id: '1' }))).rejects.toBeInstanceOf(
      UnknownRecordKindError,
    )
    // a prefixed hub id is the same owner
    expect(await provider.get(stamped('addon:a', { kind: 'cfg', id: '1' }))).toMatchObject({
      data: { v: 1 },
    })
  })

  it('refuses to move a kind to the other file', async () => {
    const { provider } = makeProvider()
    await provider.declareKinds(
      stamped('a', { kinds: { ev: declaration({ database: 'events' }) } }),
    )
    await expect(
      provider.declareKinds(stamped('a', { kinds: { ev: declaration({ database: 'settings' }) } })),
    ).rejects.toBeInstanceOf(DeclarationRefusedError)
  })

  it('rebuilds the placement from the files after a restart', async () => {
    const { provider, settings, events } = makeProvider()
    await provider.declareKinds(
      stamped('a', { kinds: { ev: declaration({ database: 'events' }) } }),
    )
    await provider.put(
      stamped('a', {
        kind: 'ev',
        record: { id: '1', deviceId: 1, at: 1, data: {} },
      }),
    )
    const router = {
      openFiles: () => [settings, events],
      recordsFileFor: async (id: DataStoreDatabase) => (id === 'events' ? events : settings),
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: a two-method stand-in for the router in a spec
    const reborn = new RecordsProvider(router as unknown as PlacementRouter, silentLogger())
    await expect(reborn.get(stamped('a', { kind: 'ev', id: '1' }))).rejects.toBeInstanceOf(
      UnknownRecordKindError,
    )
    await reborn.init()
    expect(await reborn.get(stamped('a', { kind: 'ev', id: '1' }))).not.toBeNull()
  })

  it('a declaration an addon sends is strict: an unknown key is refused', async () => {
    const { provider } = makeProvider()
    const unknown = {
      ...declaration({ device: 'none', at: 'none', class: 'config' }),
      retiredKey: 'x',
    }
    await expect(provider.declareKinds(stamped('a', { kinds: { cfg: unknown } }))).rejects.toThrow()
  })

  it('a catalog row an older engine wrote, with a key this engine no longer knows, still loads', async () => {
    const { provider, settings } = makeProvider()
    const plain = declaration({ device: 'none', at: 'none', class: 'config' })
    await provider.declareKinds(stamped('a', { kinds: { cfg: plain } }))
    settings.db
      .prepare('UPDATE _record_kinds SET declaration = ? WHERE kind = ?')
      .run(JSON.stringify({ ...plain, retiredKey: 'legacy:rows' }), 'cfg')
    // A restart: the engine reads its own catalog; the unknown key is dropped, never a crash.
    const reopened = new RecordsEngine(settings.db, {
      databaseId: 'settings',
      logger: silentLogger(),
    })
    const listed = await reopened.listKinds({ owner: 'a', counts: false })
    expect(listed[0]?.declaration).toEqual(plain)
  })

  it('the catalog stores what was declared: a stored row that differs is rewritten even when the hash agrees', async () => {
    const { provider, settings } = makeProvider()
    const plain = declaration({ device: 'none', at: 'none', class: 'config' })
    await provider.declareKinds(stamped('a', { kinds: { cfg: plain } }))
    const storedOf = (): string =>
      settings.db
        .prepare<[string], { declaration: string }>(
          'SELECT declaration FROM _record_kinds WHERE kind = ?',
        )
        .get('cfg')?.declaration ?? ''
    const declared = storedOf()
    // Same manifest_hash, a stored declaration that carries an extra key.
    settings.db
      .prepare('UPDATE _record_kinds SET declaration = ? WHERE kind = ?')
      .run(JSON.stringify({ ...plain, retiredKey: 'legacy:rows' }), 'cfg')
    expect(storedOf()).not.toBe(declared)
    const reopened = new RecordsEngine(settings.db, {
      databaseId: 'settings',
      logger: silentLogger(),
    })
    const again = await reopened.declareKinds({
      owner: 'a',
      kinds: { cfg: plain },
    })
    expect(again.kinds['cfg']?.state).toBe('unchanged')
    expect(storedOf()).toBe(declared)
  })

  it('transactFamily: a family split across files is refused, in one call or across calls', async () => {
    const { provider } = makeProvider()
    const parent = declaration({
      device: 'none',
      class: 'config',
      transactFamily: 'gallery',
    })
    const child = declaration({
      database: 'events',
      transactFamily: 'gallery',
    })
    await expect(
      provider.declareKinds(stamped('a', { kinds: { parent, child } })),
    ).rejects.toBeInstanceOf(DeclarationRefusedError)
    // the parent alone is fine; its child declared later in the OTHER file is refused
    await provider.declareKinds(stamped('a', { kinds: { parent } }))
    await expect(provider.declareKinds(stamped('a', { kinds: { child } }))).rejects.toBeInstanceOf(
      DeclarationRefusedError,
    )
    // the same family name of ANOTHER owner is another family
    await provider.declareKinds(stamped('b', { kinds: { child } }))
    // one file, one family: accepted
    const together = {
      p2: declaration({ database: 'events', transactFamily: 'pairs' }),
      c2: declaration({ database: 'events', transactFamily: 'pairs' }),
    }
    await provider.declareKinds(stamped('a', { kinds: together }))
  })

  it("admin: lists every kind of both files and reads another owner's kind", async () => {
    const { provider } = makeProvider()
    await provider.declareKinds(
      stamped('a', {
        kinds: {
          ev: declaration({ database: 'events' }),
          cfg: declaration({ device: 'none', at: 'none', class: 'config' }),
        },
      }),
    )
    await provider.putMany(
      stamped('a', {
        kind: 'ev',
        records: [1, 2, 3].map((n) => ({
          id: `r${n}`,
          deviceId: 1,
          at: n,
          data: { n },
        })),
      }),
    )
    const listed = await provider.listKinds({})
    expect(listed.kinds.map((k) => [k.kind, k.rows])).toEqual(
      expect.arrayContaining([
        ['cfg', 0],
        ['ev', 3],
      ]),
    )
    expect((await provider.listKinds({ owner: 'nobody' })).kinds).toEqual([])
    const read = await provider.readRecords({
      owner: 'a',
      kind: 'ev',
      limit: 10,
      deviceId: 1,
    })
    expect(read.records.map((r) => r.id)).toEqual(['r1', 'r2', 'r3'])
    await expect(
      provider.readRecords({ owner: 'a', kind: 'ghost', limit: 1 }),
    ).rejects.toBeInstanceOf(UnknownRecordKindError)
  })

  it("deleteDevice fans out to every file that holds the owner's kinds", async () => {
    const { provider } = makeProvider()
    await provider.declareKinds(
      stamped('a', {
        kinds: {
          a1: declaration({ database: 'events', deviceRemoval: 'delete' }),
          a2: declaration({ deviceRemoval: 'delete' }),
        },
      }),
    )
    for (const kind of ['a1', 'a2']) {
      await provider.put(
        stamped('a', {
          kind,
          record: { id: 'r', deviceId: 9, at: 1, data: {} },
        }),
      )
    }
    const result = await provider.deleteDevice(stamped('a', { deviceId: 9 }))
    expect(result.deleted).toEqual({ a1: 1, a2: 1 })
  })
})
