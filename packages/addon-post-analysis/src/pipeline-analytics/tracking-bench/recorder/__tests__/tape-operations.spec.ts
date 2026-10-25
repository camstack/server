/**
 * The `debug.tape.release` / `delete` / start-reconcile bodies (fix round 2,
 * N3), lifted out of `index.ts` so what they answer is tested:
 *
 *  - the pin deps are built from the index and the track store ALONE — a
 *    node with no shelf (recorder down, refused, artifacts elsewhere) can
 *    still release and reconcile;
 *  - delete needs the shelf, and without it names why;
 *  - an operation that cannot run answers `unavailable` with that reason —
 *    never folded into `already-released` / `not-found`, which are answers
 *    (D393).
 *
 * Disarms:
 *  - in `buildTapePinDeps`, return the shelf's absence when the shelf is
 *    missing — "pin deps need no shelf" fails;
 *  - in `releaseOrUnavailable`, answer `{ status: 'already-released' }` for a
 *    string — "cannot release is unavailable" fails;
 *  - in `deleteOrUnavailable`, answer `{ status: 'not-found' }` for a string —
 *    "cannot delete is unavailable" fails.
 *
 * `reviewOrNotFound` (fix round, L2): `debug.tape.review` used to answer
 * `{ reviewed }` — success — for an unknown or already-deleted `tapeId`,
 * because `update.mutate` is a silent no-op on a missing primary key. It now
 * `get`s first, like `releaseTape` / `deleteTape`.
 *
 * Disarm: skip the `get` and always write — "an unknown tapeId is refused"
 * fails.
 */
import { describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../../__tests__/test-helpers.js'
import { TapeOperationQueue } from '../tape-operation-queue.js'
import {
  buildTapeDeleteDeps,
  buildTapePinDeps,
  deleteOrUnavailable,
  reconcileOrUnavailable,
  releaseOrUnavailable,
  reviewOrNotFound,
  type TapeDepsSources,
} from '../tape-operations.js'
import { promoteTapeWindow } from '../tape-promotion.js'
import { ORIGIN, type World, world } from './promotion-world.js'

function sources(w: World, over: Partial<TapeDepsSources> = {}): TapeDepsSources {
  return {
    index: w.deps.index,
    trackStore: { setBenchPinned: w.deps.pin },
    shelf: { promotedFile: w.deps.promotedFile },
    shelfAbsence: () => 'artifacts-elsewhere',
    removeFile: w.deps.removeFile,
    logger: w.deps.logger,
    now: w.deps.now,
    ...over,
  }
}

function queue(): TapeOperationQueue {
  return new TapeOperationQueue({ logger: makeLogRecorder().logger })
}

describe('tape operations — deps and unavailable', () => {
  it('pin deps need no shelf; they need the index and the track store', async () => {
    const w = await world()
    expect(typeof buildTapePinDeps(sources(w, { shelf: null }))).toBe('object')
    expect(buildTapePinDeps(sources(w, { trackStore: null }))).toBe('the track store is not ready')
    expect(buildTapePinDeps(sources(w, { index: null }))).toBe('the track store is not ready')
  })

  it('delete deps need the shelf, and name why it is missing', async () => {
    const w = await world()
    expect(buildTapeDeleteDeps(sources(w, { shelf: null }))).toBe('artifacts-elsewhere')
    expect(typeof buildTapeDeleteDeps(sources(w))).toBe('object')
  })

  it('cannot release is unavailable, never already-released', async () => {
    expect(await releaseOrUnavailable('tapes-not-started', 'promo-0001', queue())).toEqual({
      status: 'unavailable',
      reason: 'tapes-not-started',
    })
  })

  it('cannot delete is unavailable, never not-found', async () => {
    expect(await deleteOrUnavailable('artifacts-elsewhere', 'promo-0001', queue())).toEqual({
      status: 'unavailable',
      reason: 'artifacts-elsewhere',
    })
  })

  it('cannot reconcile is unavailable', async () => {
    expect(await reconcileOrUnavailable('the track store is not ready', queue())).toEqual({
      status: 'unavailable',
      reason: 'the track store is not ready',
    })
  })

  it('a node with no shelf releases and reconciles through the queue', async () => {
    const w = await world()
    await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: 'first-one',
    })
    const deps = buildTapePinDeps(sources(w, { shelf: null }))
    const q = queue()
    expect(await releaseOrUnavailable(deps, 'promo-0001', q)).toEqual({
      status: 'released',
      unpinned: 2,
      pinsSettled: true,
    })
    expect(await reconcileOrUnavailable(deps, q)).toEqual({ settled: 0, unsettled: 0 })
    expect(await deleteOrUnavailable(buildTapeDeleteDeps(sources(w)), 'promo-0001', q)).toEqual({
      status: 'deleted',
    })
  })
})

describe('reviewOrNotFound (fix round, L2)', () => {
  it('refuses an unknown tapeId rather than answering as if the write landed', async () => {
    const w = await world()
    expect(await reviewOrNotFound(w.index, 'no-such-tape', true)).toEqual({ status: 'not-found' })
  })

  it('marks a known tape reviewed, and the row actually changes', async () => {
    const w = await world()
    await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: 'first-one',
    })
    expect((await w.index.get('promo-0001'))?.reviewed).toBe(false)
    expect(await reviewOrNotFound(w.index, 'promo-0001', true)).toEqual({
      status: 'reviewed',
      reviewed: true,
    })
    expect((await w.index.get('promo-0001'))?.reviewed).toBe(true)
  })

  it('refuses a tapeId that was reviewed then deleted', async () => {
    const w = await world()
    await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: 'first-one',
    })
    await w.index.remove('promo-0001')
    expect(await reviewOrNotFound(w.index, 'promo-0001', true)).toEqual({ status: 'not-found' })
  })
})
