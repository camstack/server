/**
 * The pins a promoted tape holds (decision 11): releasing a promotion unpins
 * only the tracks no other live promotion still names; a delete never drops a
 * row whose unpins have not landed; and — fix round, M2 — release and
 * reconcile need only the index and the pins, never the recorder or the
 * shelf, and every outcome is named (`released`, `already-released`,
 * `not-found`, `pins-owed`), so "could not" never reads as "nothing to do".
 *
 * Disarms:
 *  - in `settleRow`'s unpin set, unpin every id of the row (ignore the
 *    others' pins) — "keeps a track another promotion still names" must fail;
 *  - (Task 12) in `deleteTape`, skip the unsettled check — "delete keeps the
 *    row while its unpins have not landed" must fail;
 *  - (fix round, M2) answer `not-found` for an already-released row — "an
 *    already-released tape says so" must fail.
 */
import { describe, expect, it } from 'vitest'
import { deleteTape, releaseTape, reconcileTapePins, type TapePinDeps } from '../tape-pin-ledger.js'
import { promoteTapeWindow } from '../tape-promotion.js'
import { NOW, ORIGIN, world } from './promotion-world.js'

describe('releaseTape / deleteTape', () => {
  it('keeps a track another promotion still names', async () => {
    const w = await world()
    await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: 'first-one',
    })
    await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 500,
      scenario: 'second-one',
    })
    const r = await releaseTape(w.deps, 'promo-0001')
    expect(r).toEqual({ status: 'released', unpinned: 1, pinsSettled: true })
    expect(w.pins.get('trk-a')).toBe(true)
    expect(w.pins.get('trk-b')).toBe(false)
  })

  it('an already-released tape says so, and an unknown one is not-found (fix round, M2)', async () => {
    const w = await world()
    await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: 'first-one',
    })
    expect(await releaseTape(w.deps, 'promo-0001')).toMatchObject({ status: 'released' })
    expect(await releaseTape(w.deps, 'promo-0001')).toEqual({ status: 'already-released' })
    expect(await releaseTape(w.deps, 'promo-9999')).toEqual({ status: 'not-found' })
    expect(await deleteTape(w.deps, 'promo-9999')).toEqual({ status: 'not-found' })
  })

  it('release and reconcile work without the recorder or the shelf (fix round, M2)', async () => {
    const w = await world()
    await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: 'first-one',
    })
    // What a hub whose recorder is down or refused can still build.
    const pinOnly: TapePinDeps = {
      index: w.deps.index,
      pin: w.deps.pin,
      logger: w.deps.logger,
      now: w.deps.now,
    }
    w.faults.failingPins.add('trk-b')
    expect(await releaseTape(pinOnly, 'promo-0001')).toEqual({
      status: 'released',
      unpinned: 1,
      pinsSettled: false,
    })
    w.faults.failingPins.clear()
    expect(await reconcileTapePins(pinOnly)).toEqual({ settled: 1, unsettled: 0 })
    expect(w.pins.get('trk-b')).toBe(false)
  })

  it('delete releases, removes the file and the row', async () => {
    const w = await world()
    await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: 'first-one',
    })
    expect(await deleteTape(w.deps, 'promo-0001')).toEqual({ status: 'deleted' })
    expect(w.written.size).toBe(0)
    expect(await w.index.get('promo-0001')).toBeNull()
    expect(w.pins.get('trk-a')).toBe(false)
  })

  it('delete keeps the row while its unpins have not landed, and a later delete finishes (Task 12)', async () => {
    const w = await world()
    await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: 'first-one',
    })
    w.faults.failingPins.add('trk-a')
    expect(await deleteTape(w.deps, 'promo-0001')).toEqual({ status: 'pins-owed' })
    // The row stays — released, unsettled — so the pin on trk-a is still
    // named by an index row and will be taken back.
    expect(await w.index.get('promo-0001')).toMatchObject({ releasedAt: NOW, pinsSettled: false })
    expect(w.written.size).toBe(1)
    expect(w.pins.get('trk-a')).toBe(true)

    w.faults.failingPins.clear()
    expect(await deleteTape(w.deps, 'promo-0001')).toEqual({ status: 'deleted' })
    expect(w.pins.get('trk-a')).toBe(false)
    expect(await w.index.get('promo-0001')).toBeNull()
  })
})
