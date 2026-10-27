/**
 * `applyTrackFlags` — the cap-level `setTrackFlags` body, extracted so the
 * partial-patch merge and the unknown-track rejection are testable without
 * booting the addon (same shape as `sweepTrackRetention` / `rankKeyEvents`).
 */

import type { RetrainStatus, Track } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { type PeakLookup, rankKeyEvents } from '../key-event-query.js'
import {
  type ApplyTrackFlagsDeps,
  applyTrackFlags,
  MAX_STAGING_TRACKS_PER_DEVICE,
  StagingBudgetExceededError,
  TrackAlreadyTrainedError,
  retrainRefusalReason,
  type TrackFlagsStore,
} from '../track-flags.js'

type FakeFlagsStore = TrackFlagsStore & {
  readonly writes: { trackId: string; patch: Record<string, unknown> }[]
}

function makeStore(
  current: {
    retrainStatus: RetrainStatus
    debug: boolean
    favourited?: boolean
    debugNote?: string
  } | null,
  staging = 0,
): FakeFlagsStore {
  const writes: { trackId: string; patch: Record<string, unknown> }[] = []
  return {
    writes,
    // The note is reported the way the real store reports it — resolved, never
    // absent. A fake that invented `''` here would let a body that forgot to
    // read the column pass, which is the exact way this repo has shipped a
    // green test over a missing fetch twice.
    readFlags: vi.fn(async () =>
      current === null
        ? null
        : {
            retrainStatus: current.retrainStatus,
            debug: current.debug,
            favourited: current.favourited === true,
            debugNote: current.debugNote ?? '',
          },
    ),
    setFlags: vi.fn(async (trackId, patch) => {
      writes.push({ trackId, patch: { ...patch } })
    }),
    countStaging: vi.fn(async () => staging),
  }
}

function deps(store: TrackFlagsStore): ApplyTrackFlagsDeps {
  return { store, logger: makeSilentLogger() }
}

describe('applyTrackFlags', () => {
  it('returns the resolved state of BOTH flags after a single-key patch', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: true })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'track-9',
      flags: { markForTrain: true },
    })

    expect(out).toEqual({
      trackId: 'track-9',
      markForTrain: true,
      debug: true,
      debugNote: '',
      favourited: false,
      retrainStatus: 'staging',
    })
  })

  it('forwards only the keys the caller sent — an omitted flag is never written', async () => {
    const store = makeStore({ retrainStatus: 'staging', debug: false })

    await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'track-9',
      flags: { debug: true },
    })

    expect(store.writes).toEqual([{ trackId: 'track-9', patch: { debug: true } }])
  })

  it('rejects an unknown track instead of reporting a write that went nowhere', async () => {
    const store = makeStore(null)

    await expect(
      applyTrackFlags(deps(store), { deviceId: 101, trackId: 'ghost', flags: { debug: true } }),
    ).rejects.toThrow(/ghost/)
    expect(store.setFlags).not.toHaveBeenCalled()
  })

  it('an empty patch is a read — it reports current state and writes nothing', async () => {
    const store = makeStore({ retrainStatus: 'staging', debug: false })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'track-9',
      flags: {},
    })

    expect(out).toEqual({
      trackId: 'track-9',
      markForTrain: true,
      debug: false,
      debugNote: '',
      favourited: false,
      retrainStatus: 'staging',
    })
    expect(store.setFlags).not.toHaveBeenCalled()
  })

  it('reports a TRAINED track as NOT marked — markForTrain means staging', async () => {
    const store = makeStore({ retrainStatus: 'trained', debug: false })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'done',
      flags: {},
    })

    expect(out).toEqual({
      trackId: 'done',
      markForTrain: false,
      debug: false,
      debugNote: '',
      favourited: false,
      retrainStatus: 'trained',
    })
  })
})

/**
 * `favourited` is a BOOLEAN durability pin, independent of the retrain
 * lifecycle and of `debug`. One key per write; absent collapses to OFF.
 */
describe('applyTrackFlags — favourited', () => {
  it('sets and clears favourited as its own key', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: false })

    const on = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'keep',
      flags: { favourited: true },
    })
    expect(store.writes).toEqual([{ trackId: 'keep', patch: { favourited: true } }])
    expect(on.favourited).toBe(true)
    expect(on.debug).toBe(false)
    expect(on.markForTrain).toBe(false)
    expect(on.retrainStatus).toBe('none')

    const off = await applyTrackFlags(
      deps(makeStore({ retrainStatus: 'none', debug: false, favourited: true })),
      { deviceId: 101, trackId: 'keep', flags: { favourited: false } },
    )
    expect(off.favourited).toBe(false)
  })

  it('an omitted favourited is never written — independence from debug/markForTrain', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: false, favourited: true })

    await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'keep',
      flags: { debug: true },
    })

    expect(store.writes).toEqual([{ trackId: 'keep', patch: { debug: true } }])
  })

  it('absent favourited renders OFF on the resolved answer', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: false })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'plain',
      flags: {},
    })

    expect(out.favourited).toBe(false)
  })

  it('ALLOWS a favourited patch on a trained track — it is not the lifecycle', async () => {
    const store = makeStore({ retrainStatus: 'trained', debug: false })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'done',
      flags: { favourited: true },
    })

    expect(store.writes).toEqual([{ trackId: 'done', patch: { favourited: true } }])
    expect(out.retrainStatus).toBe('trained')
    expect(out.favourited).toBe(true)
    expect(out.markForTrain).toBe(false)
  })

  it('ALLOWS a favourited patch at the staging limit — no budget on Favourited', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: false }, MAX_STAGING_TRACKS_PER_DEVICE)

    await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'keep',
      flags: { favourited: true },
    })

    expect(store.writes).toEqual([{ trackId: 'keep', patch: { favourited: true } }])
    expect(store.countStaging).not.toHaveBeenCalled()
  })
})

/**
 * `trained` is TERMINAL for this toggle (D81). A trained track's frames are
 * already copies inside the retrain dataset, and re-staging it from a generic
 * toggle is how the same material gets annotated twice under two different
 * ground truths. Returning it to staging deliberately is the retrain page's own
 * action, not this one — so BOTH directions are refused here, with a distinct
 * error type so the surface can say which of the two refusals it hit.
 */
describe('applyTrackFlags — trained is terminal for the toggle', () => {
  it('refuses to re-stage a trained track', async () => {
    const store = makeStore({ retrainStatus: 'trained', debug: false })

    await expect(
      applyTrackFlags(deps(store), {
        deviceId: 101,
        trackId: 'done',
        flags: { markForTrain: true },
      }),
    ).rejects.toBeInstanceOf(TrackAlreadyTrainedError)
    expect(store.setFlags).not.toHaveBeenCalled()
  })

  it('refuses to un-mark a trained track too — the toggle owns neither direction', async () => {
    const store = makeStore({ retrainStatus: 'trained', debug: false })

    await expect(
      applyTrackFlags(deps(store), {
        deviceId: 101,
        trackId: 'done',
        flags: { markForTrain: false },
      }),
    ).rejects.toBeInstanceOf(TrackAlreadyTrainedError)
    expect(store.setFlags).not.toHaveBeenCalled()
  })

  it('names the track, so the refusal is actionable', async () => {
    const store = makeStore({ retrainStatus: 'trained', debug: false })

    await expect(
      applyTrackFlags(deps(store), {
        deviceId: 101,
        trackId: 'done',
        flags: { markForTrain: true },
      }),
    ).rejects.toThrow(/done/)
  })

  it('still ALLOWS a debug patch on a trained track — debug is not the lifecycle', async () => {
    const store = makeStore({ retrainStatus: 'trained', debug: false })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'done',
      flags: { debug: true },
    })

    expect(store.writes).toEqual([{ trackId: 'done', patch: { debug: true } }])
    expect(out.retrainStatus).toBe('trained')
  })
})

/**
 * `debugNote` — the operator's own words about what should be checked on THIS
 * track. It exists only for the duration of the debug flag: a note left behind
 * on a track nobody is looking at any more is a leftover that reads as a live
 * request.
 *
 * The invariant is enforced HERE and not in the app, because three surfaces
 * write this patch and only one of them is the app. Two consequences, both
 * asserted below: turning debug OFF clears the note whatever the caller sent,
 * and a note aimed at a track whose debug is off (and is not being turned on)
 * is DROPPED — with a line, because a branch that silently discards an
 * operator's sentence is indistinguishable from one that stored it.
 */
describe('applyTrackFlags — the debug note', () => {
  it('stores the note beside the flag it explains', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: false })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'noisy',
      flags: { debug: true, debugNote: 'the box jumps to the fence at 22:14' },
    })

    expect(store.writes).toEqual([
      {
        trackId: 'noisy',
        patch: { debug: true, debugNote: 'the box jumps to the fence at 22:14' },
      },
    ])
    expect(out.debug).toBe(true)
    expect(out.debugNote).toBe('the box jumps to the fence at 22:14')
  })

  it('reports the STORED note when the patch does not carry one', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: true, debugNote: 'check the crop' })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'noisy',
      flags: { favourited: true },
    })

    expect(out.debugNote).toBe('check the crop')
  })

  it('leaves the stored note alone when debug is re-asserted with no note — a cancelled prompt costs nothing', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: false, debugNote: 'earlier words' })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'noisy',
      flags: { debug: true },
    })

    expect(store.writes).toEqual([{ trackId: 'noisy', patch: { debug: true } }])
    expect(out.debugNote).toBe('earlier words')
  })

  it('lets the operator EDIT the note while debug stays on', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: true, debugNote: 'first take' })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'noisy',
      flags: { debugNote: 'second take' },
    })

    expect(store.writes).toEqual([{ trackId: 'noisy', patch: { debugNote: 'second take' } }])
    expect(out.debugNote).toBe('second take')
    expect(out.debug).toBe(true)
  })

  it('CLEARS the note when debug goes off, even though the caller sent none', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: true, debugNote: 'was checking this' })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'noisy',
      flags: { debug: false },
    })

    expect(store.writes).toEqual([{ trackId: 'noisy', patch: { debug: false, debugNote: '' } }])
    expect(out.debugNote).toBe('')
  })

  it('CLEARS the note when debug goes off even if the caller sent a note with it', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: true, debugNote: 'was checking this' })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'noisy',
      flags: { debug: false, debugNote: 'still worth a look' },
    })

    expect(store.writes).toEqual([{ trackId: 'noisy', patch: { debug: false, debugNote: '' } }])
    expect(out.debugNote).toBe('')
  })

  it('DROPS a note aimed at a track whose debug is off, and logs the drop with the deviceId', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: false })
    const logger = makeSilentLogger()
    const warn = vi.spyOn(logger, 'warn')

    const out = await applyTrackFlags(
      { store, logger },
      { deviceId: 101, trackId: 'quiet', flags: { debugNote: 'nobody asked for this' } },
    )

    expect(store.setFlags).not.toHaveBeenCalled()
    expect(out.debugNote).toBe('')
    expect(warn).toHaveBeenCalledTimes(1)
    const [message, meta] = warn.mock.calls[0] ?? []
    expect(String(message)).toMatch(/debug note/i)
    expect(meta).toMatchObject({ tags: { deviceId: 101 } })
  })

  it('does not treat an empty note as a no-op — clearing the note is a real write', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: true, debugNote: 'stale' })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'noisy',
      flags: { debugNote: '' },
    })

    expect(store.writes).toEqual([{ trackId: 'noisy', patch: { debugNote: '' } }])
    expect(out.debugNote).toBe('')
  })
})

/**
 * The staging budget (D81). A `staging` track holds itself and its media out of
 * retention indefinitely, so the number one camera may hold is capped. Every
 * case below is about which operations that cap is allowed to block — and the
 * three it must NOT block are the point of the block. `trained` tracks are NOT
 * counted: they are evictable again, so they cost the budget nothing.
 */
describe('applyTrackFlags — the per-device staging budget', () => {
  it('refuses a NEW staging mark once the device is at the limit', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: false }, MAX_STAGING_TRACKS_PER_DEVICE)

    await expect(
      applyTrackFlags(deps(store), {
        deviceId: 101,
        trackId: 'one-too-many',
        flags: { markForTrain: true },
      }),
    ).rejects.toBeInstanceOf(StagingBudgetExceededError)
    expect(store.setFlags).not.toHaveBeenCalled()
  })

  it('names the device and the limit, so the refusal is actionable', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: false }, MAX_STAGING_TRACKS_PER_DEVICE)

    await expect(
      applyTrackFlags(deps(store), {
        deviceId: 101,
        trackId: 'one-too-many',
        flags: { markForTrain: true },
      }),
    ).rejects.toThrow(new RegExp(`101.*${MAX_STAGING_TRACKS_PER_DEVICE}`))
  })

  it('ALLOWS un-marking at the limit — the way out is never blocked', async () => {
    const store = makeStore(
      { retrainStatus: 'staging', debug: false },
      MAX_STAGING_TRACKS_PER_DEVICE,
    )

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'pinned',
      flags: { markForTrain: false },
    })

    expect(out.markForTrain).toBe(false)
    expect(store.writes).toEqual([{ trackId: 'pinned', patch: { markForTrain: false } }])
  })

  it('ALLOWS a debug patch at the limit — the budget is about staging, not flags', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: false }, MAX_STAGING_TRACKS_PER_DEVICE)

    await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'noisy',
      flags: { debug: true },
    })

    expect(store.writes).toEqual([{ trackId: 'noisy', patch: { debug: true } }])
    expect(store.countStaging).not.toHaveBeenCalled()
  })

  it('ALLOWS re-marking an already-staging track — it consumes no new budget', async () => {
    const store = makeStore(
      { retrainStatus: 'staging', debug: false },
      MAX_STAGING_TRACKS_PER_DEVICE,
    )

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'pinned',
      flags: { markForTrain: true },
    })

    expect(out.markForTrain).toBe(true)
    expect(store.countStaging).not.toHaveBeenCalled()
  })

  it('lets a mark through with one slot left', async () => {
    const store = makeStore(
      { retrainStatus: 'none', debug: false },
      MAX_STAGING_TRACKS_PER_DEVICE - 1,
    )

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'last-slot',
      flags: { markForTrain: true },
    })

    expect(out.markForTrain).toBe(true)
  })
})

/**
 * The Events grid renders one row per track and one toggle per flag. If the
 * flags did not ride the feed row, every card would need its own `getTrack` —
 * 200 extra round trips per camera — or the toggles would render unchecked
 * until touched, which reads as "nothing is flagged".
 */
describe('rankKeyEvents carries the operator flags onto the feed row', () => {
  function track(partial: Partial<Track> & { trackId: string }): Track {
    return {
      trackId: partial.trackId,
      deviceId: 101,
      className: 'person',
      firstSeen: 1000,
      lastSeen: 2000,
      positions: [],
      snapshots: [],
      zonesVisited: [],
      totalDistance: 0,
      state: 'idle',
      active: false,
      importance: partial.importance ?? 0.5,
      bestEventId: 'e-1',
      ...(partial.markForTrain !== undefined ? { markForTrain: partial.markForTrain } : {}),
      ...(partial.retrainStatus !== undefined ? { retrainStatus: partial.retrainStatus } : {}),
      ...(partial.debug !== undefined ? { debug: partial.debug } : {}),
      ...(partial.favourited !== undefined ? { favourited: partial.favourited } : {}),
    }
  }

  const failPeak: PeakLookup = () => {
    throw new Error('peakLookup should not be called for scored rows')
  }

  it('passes markForTrain, retrainStatus, debug and favourited straight through', async () => {
    const out = await rankKeyEvents(
      [
        track({
          trackId: 'flagged',
          markForTrain: true,
          retrainStatus: 'staging',
          debug: false,
          favourited: true,
        }),
      ],
      { limit: 10 },
      failPeak,
    )

    expect(out[0]?.markForTrain).toBe(true)
    expect(out[0]?.retrainStatus).toBe('staging')
    expect(out[0]?.debug).toBe(false)
    expect(out[0]?.favourited).toBe(true)
  })

  it('carries retrainStatus:trained onto the row, so the grid can badge it', async () => {
    // The badge the retrain page needs and the boolean cannot express: a
    // trained track reports `markForTrain: false`, which without the status
    // beside it is indistinguishable from never having been marked at all.
    const out = await rankKeyEvents(
      [track({ trackId: 'done', markForTrain: false, retrainStatus: 'trained' })],
      { limit: 10 },
      failPeak,
    )

    expect(out[0]?.retrainStatus).toBe('trained')
  })

  it('leaves an untouched track ABSENT rather than defaulting it to false', async () => {
    const out = await rankKeyEvents([track({ trackId: 'plain' })], { limit: 10 }, failPeak)

    expect(out[0]).not.toHaveProperty('markForTrain')
    expect(out[0]).not.toHaveProperty('retrainStatus')
    expect(out[0]).not.toHaveProperty('debug')
    expect(out[0]).not.toHaveProperty('favourited')
  })
})

describe('retrainRefusalReason', () => {
  it('classifies the real refusals, also after the error class was lost over ctx.api', () => {
    const trained = new TrackAlreadyTrainedError('t1')
    const budget = new StagingBudgetExceededError(7, 500)
    expect(retrainRefusalReason(trained)).toBe('trained')
    expect(retrainRefusalReason(budget)).toBe('budget')
    // Only the message crosses the hop.
    expect(retrainRefusalReason(new Error(trained.message))).toBe('trained')
    expect(retrainRefusalReason(new Error(budget.message))).toBe('budget')
    expect(retrainRefusalReason(new Error('setTrackFlags: unknown track t9'))).toBe('unknown-track')
    expect(retrainRefusalReason(new Error('socket hang up'))).toBeNull()
  })
})
