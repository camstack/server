/**
 * A kept track owns its entry's key frame; no cascade may take it while the
 * entry is live (D683 round 4, review M2).
 *
 * A promoted track that MOVED is kept and closes normally. The entry was born
 * with that track's key frame, which stays a `track`-owned row — so the
 * retention sweep that later cascades the track would delete the bytes a live
 * entry points at. The addon runs every track cascade (retention, discard,
 * operator delete, the promotion disposal) through `sparingEntryHeldMedia`.
 * Over the real stores:
 *
 * Disarms (each alone, restored):
 *  - in `sparingEntryHeldMedia`, pass only `opts.spare` (drop `held()`):
 *    "retention of a kept track leaves the live entry's key frame" fails;
 *  - pass only `held()` (drop `opts.spare`): "a caller's own spare set still
 *    counts" fails.
 *
 * Fix round 2 (review R6): an operator delete that spared a row SAYS so —
 * `entryHeldMediaOf` names the held rows the deleted tracks own:
 *  - return every held id, whoever owns it: "names only the held rows the
 *    deleted tracks own" fails;
 *  - return `[]`: the same test fails.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
} from '../../../__tests__/test-helpers.js'
import { MediaStore } from '../../../store/media-store.js'
import { TrackStore } from '../../../store/track-store.js'
import { cascadeDeleteTracks } from '../../delete-track-cascade.js'
import { entryHeldMediaOf, sparingEntryHeldMedia } from '../stationary-track-disposal.js'

const DEVICE_ID = 103
const T0 = 1_790_000_000_000

describe('sparingEntryHeldMedia', () => {
  let fake: FakeSettingsStore
  let media: MediaStore
  let tracks: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    media = new MediaStore({
      storage: makeFakeStorageProvider(),
      store: fake.client,
      logger: makeSilentLogger(),
    })
    tracks = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await MediaStore.declare(fake.client)
    await TrackStore.declare(fake.client)
  })

  const put = (trackId: string, kind: 'keyFrame' | 'thumbnail'): Promise<number> =>
    media.put({
      deviceId: DEVICE_ID,
      ownerKind: 'track',
      ownerId: trackId,
      kind,
      timestamp: T0,
      data: Buffer.alloc(1_024, 1),
    })

  it('retention of a kept track leaves the live entry’s key frame, and takes the rest', async () => {
    const keyFrame = await put('kept', 'keyFrame')
    const thumb = await put('kept', 'thumbnail')
    let held: ReadonlySet<number> = new Set([keyFrame])
    const leg = sparingEntryHeldMedia(media, () => held)

    await cascadeDeleteTracks([leg], tracks, ['kept'])

    expect(await media.getById(keyFrame)).not.toBeNull()
    expect(await media.getById(thumb)).toBeNull()
    // Once the entry has retired nothing holds it: the next cascade takes it.
    held = new Set()
    await leg.deleteByTracks(['kept'])
    expect(await media.getById(keyFrame)).toBeNull()
  })

  it('a caller’s own spare set still counts', async () => {
    const keyFrame = await put('disposed', 'keyFrame')
    const leg = sparingEntryHeldMedia(media, () => new Set())

    await leg.deleteByTracks(['disposed'], { spare: new Set([keyFrame]) })

    expect(await media.getById(keyFrame)).not.toBeNull()
  })

  it('names only the held rows the deleted tracks own (R6)', async () => {
    const mine = await put('deleted', 'keyFrame')
    const theirs = await put('other', 'keyFrame')
    const unheld = await put('deleted', 'thumbnail')
    const held = new Set([mine, theirs])
    expect(unheld).toBeGreaterThan(0)

    const spared = await entryHeldMediaOf(['deleted'], held, (id) => media.ownerOf(id))

    expect(spared).toEqual([mine])
  })
})
