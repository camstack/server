/**
 * What a registry promotion does to each TRACK it touches (D683 round 4, fix
 * round 1 — review H3/H4/M4). Two tracks can carry a promotion's evidence:
 * the LIVE one on the tipping frame, and the SOURCE of the entry's best box
 * (often an earlier piece of the same subject). Each is judged on its OWN
 * path: a track that moved is kept and closes normally; only a track that
 * never moved is disposed (D547). A source in the live track's own L2 chain
 * is the same subject and shares the live track's fate; a source whose path
 * could not be read is left alone (a failed read changes nothing, D49).
 *
 * Disarms (each alone, restored):
 *  - force "dispose everything" in `planPromotionEffects`: every "keeps" case fails;
 *  - ignore the source's own plan (the brief's "pass only sourceTrackId"):
 *    "a moved source is kept though the live track never moved" fails;
 *  - ignore `sameChainAsLive`: "a source in the live chain shares its fate" fails;
 *  - treat an unreadable source as never-moved: "an unreadable source is left alone" fails;
 *  - in `executePromotionEffects`, skip `markKept`: "the executor marks every kept track" fails.
 */
import { describe, expect, it } from 'vitest'
import {
  executePromotionEffects,
  planPromotionEffects,
  type PromotionPlan,
} from '../promotion-plan.js'

const MOVED: PromotionPlan = { dropReason: 'stationary', disposeLiveTrack: false }
const STILL: PromotionPlan = { dropReason: 'dropped', disposeLiveTrack: true }

describe('planPromotionEffects', () => {
  it('a moved live track is kept, closes stationary, and is not torn down now', () => {
    expect(planPromotionEffects({ liveTrackId: 'L', live: MOVED })).toEqual({
      liveDropReason: 'stationary',
      tearDownLiveNow: false,
      keepTrackIds: ['L'],
      disposeTrackIds: [],
    })
  })

  it('a never-moved live track is disposed and torn down now (D547)', () => {
    expect(planPromotionEffects({ liveTrackId: 'L', live: STILL })).toEqual({
      liveDropReason: 'dropped',
      tearDownLiveNow: true,
      keepTrackIds: [],
      disposeTrackIds: ['L'],
    })
  })

  it('a moved source is kept though the live track never moved', () => {
    // 103-shaped: A walked in, L1 split in doubt, B continued at the seat.
    const effects = planPromotionEffects({
      liveTrackId: 'B',
      live: STILL,
      source: { trackId: 'A', plan: MOVED, sameChainAsLive: false },
    })
    expect(effects.disposeTrackIds).toEqual(['B'])
    expect(effects.keepTrackIds).toEqual(['A'])
  })

  it('a never-moved source is disposed though the live track moved', () => {
    const effects = planPromotionEffects({
      liveTrackId: 'B',
      live: MOVED,
      source: { trackId: 'A', plan: STILL, sameChainAsLive: false },
    })
    expect(effects.keepTrackIds).toEqual(['B'])
    expect(effects.disposeTrackIds).toEqual(['A'])
  })

  it('a source in the live chain shares its fate, whatever its own path says', () => {
    const kept = planPromotionEffects({
      liveTrackId: 'root',
      live: MOVED,
      source: { trackId: 'member', plan: STILL, sameChainAsLive: true },
    })
    expect(kept.disposeTrackIds).toEqual([])
    expect(kept.keepTrackIds).toEqual(['root', 'member'])
    const disposed = planPromotionEffects({
      liveTrackId: 'root',
      live: STILL,
      source: { trackId: 'member', plan: MOVED, sameChainAsLive: true },
    })
    expect(disposed.disposeTrackIds).toEqual(['root', 'member'])
    expect(disposed.keepTrackIds).toEqual([])
  })

  it('an unreadable source is left alone — neither kept nor disposed', () => {
    const effects = planPromotionEffects({
      liveTrackId: 'L',
      live: STILL,
      source: { trackId: 'S', plan: null, sameChainAsLive: false },
    })
    expect(effects.disposeTrackIds).toEqual(['L'])
    expect(effects.keepTrackIds).toEqual([])
    expect(effects.leftAloneSourceTrackId).toBe('S')
  })

  it('a source that IS the live track is listed once', () => {
    const effects = planPromotionEffects({
      liveTrackId: 'L',
      live: STILL,
      source: { trackId: 'L', plan: MOVED, sameChainAsLive: true },
    })
    expect(effects.disposeTrackIds).toEqual(['L'])
    expect(effects.keepTrackIds).toEqual([])
  })
})

describe('executePromotionEffects', () => {
  it('the executor marks every kept track and disposes only the rest, after the gate', async () => {
    const order: string[] = []
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const done = executePromotionEffects(
      {
        liveDropReason: 'stationary',
        tearDownLiveNow: false,
        keepTrackIds: ['L', 'M'],
        disposeTrackIds: ['S'],
      },
      {
        markKept: (id) => {
          order.push(`keep:${id}`)
        },
        beforeDispose: gate,
        dispose: async (ids) => {
          order.push(`dispose:${ids.join(',')}`)
        },
      },
    )
    // Kept tracks are marked SYNCHRONOUSLY — before the TTL sweep can see them.
    expect(order).toEqual(['keep:L', 'keep:M'])
    open()
    await done
    expect(order).toEqual(['keep:L', 'keep:M', 'dispose:S'])
  })

  it('disposes nothing when nothing is to be disposed', async () => {
    let disposed = false
    await executePromotionEffects(
      {
        liveDropReason: 'stationary',
        tearDownLiveNow: false,
        keepTrackIds: ['L'],
        disposeTrackIds: [],
      },
      {
        markKept: () => {},
        beforeDispose: Promise.resolve(),
        dispose: async () => {
          disposed = true
        },
      },
    )
    expect(disposed).toBe(false)
  })
})
