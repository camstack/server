/**
 * Spec §6.1 invariant 5: the absorbed id resolves forever as an alias while
 * the survivor exists; aliases leave with their survivor (declared `trackId`),
 * move with it if the survivor is itself absorbed later, and widen the
 * retention cascade so late rows under an absorbed id are not orphaned (H4).
 *
 * Disarms (each alone, restored):
 *  - store the alias under column `survivorId` instead of `trackId`:
 *    "the retention derivation owns aliases by their survivor" fails;
 *  - make `cascadeDeleteTracks` ignore `expandLeafIds`: "the cascade reaches
 *    rows left under an absorbed id" fails;
 *  - drop the miss cache: "an id that is not an alias costs one store read" fails;
 *  - drop `this.misses.delete(aliasId)` from `record`: the same test's last line fails.
 *
 * D683 review N4 (`resolveMany`) disarms (each alone, restored):
 *  - page at 1 instead of `ALIAS_RESOLVE_PAGE`: the "one round trip" test fails;
 *  - read `row.id`/`row.data.trackId` off the WRONG row (e.g. always the
 *    first): the "resolves every requested alias" assertions fail.
 */
import { describe, expect, it } from 'vitest'
import { cascadeDeleteTracks } from '../pipeline/delete-track-cascade.js'
import { ANALYTICS_COLLECTIONS } from '../retention/collection-classification.js'
import {
  RECENT_ALIAS_TTL_MS,
  TRACK_ALIASES_COLLECTION,
  TrackAliasStore,
} from '../store/track-alias-store.js'
import { wireTrackAliasLedger } from '../store/event-ledger-wiring.js'
import { instrumentRecords, makeAnalyticsRecords } from './fake-records.js'
import {
  buildAliasStoreForTest,
  buildCountingAliasStoreForTest,
} from './track-store-test-helpers.js'

const noMedia = {
  moveOwner: async () => 0,
  deleteOwner: async () => 0,
  stillPresent: async () => true,
}

describe('TrackAliasStore', () => {
  it('resolves an absorbed id to its survivor', async () => {
    const aliases = await buildAliasStoreForTest()
    await aliases.record(101, 'B', 'A', 7000)
    expect(await aliases.resolve('B')).toBe('A')
    expect(aliases.resolveSync('B')).toBe('A')
    expect(await aliases.resolve('Z')).toBeNull()
  })

  it('an id that is not an alias costs one store read, not one per call; a later fusion still resolves (review 2 L5)', async () => {
    const { aliases, gets } = await buildCountingAliasStoreForTest()
    await aliases.resolve('Z')
    await aliases.resolve('Z')
    expect(gets()).toBe(1)
    await aliases.record(101, 'Z', 'A', 9000)
    expect(await aliases.resolve('Z')).toBe('A')
    // `record` clears the stale miss (`this.misses.delete(aliasId)`). The hot
    // `recent` cache answers every resolve right after the record regardless
    // of that, so the miss clear is only OBSERVABLE once `recent` has aged
    // the entry out past `RECENT_ALIAS_TTL_MS` and a resolve has to fall
    // through to the miss cache / store again — force that by recording a
    // SECOND, unrelated fusion long enough after `Z`'s that the filter in
    // `record` evicts `Z` from `recent`.
    await aliases.record(101, 'unrelated', 'Y', 9000 + RECENT_ALIAS_TTL_MS)
    expect(await aliases.resolve('Z')).toBe('A')
  })

  it('deleteAlias drops the row AND the hot cache that would still answer for it (orphan reclaim)', async () => {
    // The orphan audit reclaims an alias whose survivor is gone. A raw row
    // delete left `recent` resolving the dead alias for up to an hour, so a
    // late writer was routed to a track that no longer exists.
    const aliases = await buildAliasStoreForTest()
    await aliases.record(101, 'B', 'A', 7000)

    expect(await aliases.deleteAlias('B')).toBe(true)

    expect(aliases.resolveSync('B')).toBeUndefined()
    expect(await aliases.resolve('B')).toBeNull()
    expect(await aliases.aliasesOf(['A'])).toEqual([])
    // Nothing left to delete is an honest `false`, not a reclaim.
    expect(await aliases.deleteAlias('B')).toBe(false)
  })

  it('moves with its survivor when the survivor is absorbed', async () => {
    const aliases = await buildAliasStoreForTest()
    await aliases.record(101, 'B', 'A', 7000)
    await aliases.reassignTrack({
      deviceId: 101,
      survivorId: 'Z',
      absorbedId: 'A',
      bestShotFrom: 'survivor',
      media: noMedia,
    })
    await aliases.record(101, 'A', 'Z', 9000)
    expect(await aliases.resolve('B')).toBe('Z')
    expect([...(await aliases.aliasesOf(['Z']))].sort()).toEqual(['A', 'B'])
  })

  it('the cascade reaches rows left under an absorbed id', async () => {
    const aliases = await buildAliasStoreForTest()
    await aliases.record(101, 'B', 'A', 7000)
    const seen: string[][] = []
    const roots: string[] = []
    const leaf = { deleteByTracks: async (ids: readonly string[]) => (seen.push([...ids]), []) }
    await cascadeDeleteTracks(
      [leaf],
      { deletePersisted: async (id: string) => void roots.push(id) },
      ['A'],
      {
        expandLeafIds: (ids) => aliases.aliasesOf(ids),
      },
    )
    expect(seen).toEqual([['A', 'B']])
    expect(roots).toEqual(['A'])
  })

  it('the retention derivation owns aliases by their survivor', () => {
    const entry = ANALYTICS_COLLECTIONS.find((c) => c.collection === TRACK_ALIASES_COLLECTION)
    expect(entry?.classification.kind).toBe('track-owned')
  })

  it('resolveMany resolves a batch of aliases in ONE query round trip (review N4)', async () => {
    const counting = instrumentRecords((await makeAnalyticsRecords()).records)
    const aliases = new TrackAliasStore({
      aliasLedger: wireTrackAliasLedger({ records: counting.records }),
    })
    await aliases.record(101, 'B', 'A', 1_000)
    await aliases.record(101, 'C', 'A', 1_000)

    const before = counting.calls('getMany')
    const resolved = await aliases.resolveMany(['B', 'C', 'not-an-alias'])

    expect(counting.calls('getMany') - before, 'one round trip for the whole batch').toBe(1)
    expect(resolved.get('B')).toBe('A')
    expect(resolved.get('C')).toBe('A')
    expect(resolved.has('not-an-alias')).toBe(false)
  })

  it('resolveMany pages at 500 ids per round trip', async () => {
    const counting = instrumentRecords((await makeAnalyticsRecords()).records)
    const aliases = new TrackAliasStore({
      aliasLedger: wireTrackAliasLedger({ records: counting.records }),
    })
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`)
    const first = ids[0]
    if (first === undefined) throw new Error('empty id list')
    await aliases.record(101, first, 'A', 1_000)

    const before = counting.calls('getMany')
    const resolved = await aliases.resolveMany(ids)

    expect(counting.calls('getMany') - before, 'two pages for 501 ids').toBe(2)
    expect(resolved.get(first)).toBe('A')
    expect(resolved.size).toBe(1)
  })
})
