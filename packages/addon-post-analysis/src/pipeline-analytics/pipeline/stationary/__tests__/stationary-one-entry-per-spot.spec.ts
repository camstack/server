/**
 * One spot, one entry.
 *
 * Read off device 102 (the operator's parking lot) on 2026-09-14 at 18:58 —
 * the camera reported EIGHT parked vehicles, and four of them were this:
 *
 *   x=3476.4 y=694.8 w=360 h=774   born 14:30  label='Car'
 *   x=3476.4 y=694.8 w=360 h=774   born 16:32  label=undefined
 *   x=3476.4 y=694.8 w=360 h=774   born 17:16  label=undefined
 *   x=3476.4 y=694.8 w=360 h=774   born 18:00  label=undefined
 *
 * One car. The same box to the decimal, four rows, all four alive and all four
 * confirmed by the same frame. A fifth row was a 34x137 box sitting wholly
 * INSIDE the motorcycle's entry (IoU 0.024 — below `wakeAssocIou`, so the
 * suppression filter could not see it at all) and it had become an object of
 * its own.
 *
 * The birth path asked nobody whether the spot was already censused: it minted
 * a `randomUUID()` and called `promote()`, and `promote()` indexed and wrote.
 * The weak-continuation path (D410) keeps feeding the ledger from a track that
 * rides a parked object, so a candidate re-forms on an occupied spot roughly
 * once an hour — the re-promotion was never the anomaly, the missing guard was.
 *
 * The rule these tests pin: the registry is the ONE authority on whether a spot
 * is taken, and it answers with the SAME predicate the suppression filter uses.
 * A promotion onto an occupied spot confirms the sitting tenant instead of
 * creating a neighbour.
 */
import { makeAnalyticsRecordsNow, type FakeRecords } from '../../../__tests__/fake-records.js'
import { beforeEach, describe, expect, it } from 'vitest'

import { createNoopLogger } from '../../../../embedding-encoder/shared/noop-logger.js'
import { StationaryObjectRegistry } from '../stationary-registry.js'
import { entrySwallowsDetection } from '../stationary-match.js'
import type { StationaryBbox, StationaryEntry } from '../stationary-types.js'

/** The real 102 box, to the decimal. */
const CAR: StationaryBbox = { x: 3476.4, y: 694.8, w: 360, h: 774 }
/** The real motorcycle entry it shared the lot with. */
const BIKE: StationaryBbox = { x: 3048, y: 356.4, w: 452.4, h: 420 }
/** The 34x137 fragment that became its own row, inside BIKE. */
const FRAGMENT: StationaryBbox = { x: 3052.76, y: 373.75, w: 34.04, h: 137.01 }

const T0 = 1_789_000_000_000

function entry(over: Partial<StationaryEntry> = {}): StationaryEntry {
  return {
    id: over.id ?? 'e1',
    deviceId: 102,
    className: over.className ?? 'vehicle',
    bbox: over.bbox ?? CAR,
    frameWidth: 3840,
    frameHeight: 2160,
    firstSeenAt: over.firstSeenAt ?? T0,
    becameStationaryAt: over.becameStationaryAt ?? T0,
    lastConfirmedAt: over.lastConfirmedAt ?? T0,
    ...(over.label !== undefined ? { label: over.label } : {}),
    ...(over.keyFrameMediaId !== undefined ? { keyFrameMediaId: over.keyFrameMediaId } : {}),
  }
}

describe('one spot, one entry', () => {
  let world: FakeRecords
  let reg: StationaryObjectRegistry

  beforeEach(async () => {
    world = makeAnalyticsRecordsNow()
    reg = new StationaryObjectRegistry({ records: world.records, logger: createNoopLogger() })
  })

  it('the 102 sequence: four promotions of one car leave ONE row', async () => {
    const first = await reg.promote(entry({ id: 'a', becameStationaryAt: T0, label: 'Car' }))
    expect(first.outcome).toBe('born')

    for (const [i, at] of [T0 + 7_320_000, T0 + 9_960_000, T0 + 12_600_000].entries()) {
      const again = await reg.promote(entry({ id: `dup${i}`, becameStationaryAt: at }))
      expect(again.outcome).toBe('merged')
      expect(again.entry.id).toBe('a')
    }

    expect(reg.count(102)).toBe(1)
    // The tenant's clock advanced — the promotion was evidence, not noise.
    expect(reg.list(102)[0]?.lastConfirmedAt).toBe(T0 + 12_600_000)
  })

  it('a merge keeps the identity it already had and gains one it lacked', async () => {
    await reg.promote(entry({ id: 'a' }))
    const merged = await reg.promote(
      entry({ id: 'b', label: 'Car', keyFrameMediaId: 42, becameStationaryAt: T0 + 1000 }),
    )
    expect(merged.outcome).toBe('merged')
    expect(reg.list(102)[0]).toMatchObject({ id: 'a', label: 'Car', keyFrameMediaId: 42 })

    // …and a later nameless promotion never ERASES the name.
    await reg.promote(entry({ id: 'c', becameStationaryAt: T0 + 2000 }))
    expect(reg.list(102)[0]?.label).toBe('Car')
  })

  it('the fragment inside the motorcycle never becomes an object of its own', async () => {
    await reg.promote(entry({ id: 'bike', bbox: BIKE }))
    const frag = await reg.promote(entry({ id: 'frag', bbox: FRAGMENT }))
    expect(frag.outcome).toBe('merged')
    expect(frag.entry.id).toBe('bike')
    expect(reg.count(102)).toBe(1)
  })

  // The birth guard cannot help rows that were already written, and a duplicate
  // cannot expire on its own: every row on the spot is confirmed by the same
  // detection on the same frame, so all of them live exactly as long as the
  // object does. On 102 the four rows were all re-confirmed at 19:56, hours
  // after the guard shipped. "One spot, one row" has to be an INVARIANT.
  it('the sweep collapses rows that were already written, keeping the oldest', async () => {
    const NOW = T0 + 12_600_000
    for (const [i, at] of [T0, T0 + 7_320_000, T0 + 9_960_000, NOW].entries()) {
      await reg.promote(
        // Written the way they exist in the store today: the guard is bypassed
        // here on purpose, because that is the state on disk. All four carry the
        // SAME `lastConfirmedAt` — on 102 every one of them was confirmed by the
        // same frame, which is why none of them could age out.
        entry({
          id: `row${i}`,
          becameStationaryAt: at,
          lastConfirmedAt: NOW,
          ...(i === 0 ? { label: 'Car' } : {}),
        }),
        { suppressIou: 2, wakeAssocIou: 2 },
      )
    }
    expect(reg.count(102)).toBe(4)

    reg.noteFrame(102, NOW)
    await reg.sweep(NOW)

    expect(reg.count(102)).toBe(1)
    const survivor = reg.list(102)[0]!
    // The OLDEST survives: "parked since 14:30" is the fact the operator reads.
    expect(survivor.id).toBe('row0')
    expect(survivor.becameStationaryAt).toBe(T0)
    expect(survivor.label).toBe('Car')
  })

  it('the sweep leaves two genuinely different objects alone', async () => {
    await reg.promote(entry({ id: 'car', bbox: CAR }))
    await reg.promote(entry({ id: 'bike', bbox: BIKE }))
    reg.noteFrame(102, T0)
    await reg.sweep(T0)
    expect(reg.count(102)).toBe(2)
  })

  // CONTROLS — the guard must not swallow a genuinely different object.
  it('a second car in a DIFFERENT spot is still born', async () => {
    await reg.promote(entry({ id: 'a', bbox: CAR }))
    const other = await reg.promote(entry({ id: 'b', bbox: BIKE }))
    expect(other.outcome).toBe('born')
    expect(reg.count(102)).toBe(2)
  })

  it('a different CLASS in the same spot is still born', async () => {
    await reg.promote(entry({ id: 'a', bbox: CAR, className: 'vehicle' }))
    const person = await reg.promote(entry({ id: 'b', bbox: CAR, className: 'person' }))
    expect(person.outcome).toBe('born')
    expect(reg.count(102)).toBe(2)
  })

  it('the same spot on a DIFFERENT device is still born', async () => {
    await reg.promote(entry({ id: 'a' }))
    const elsewhere = await reg.promote({ ...entry({ id: 'b' }), deviceId: 104 })
    expect(elsewhere.outcome).toBe('born')
    expect(reg.count(102)).toBe(1)
    expect(reg.count(104)).toBe(1)
  })
})

describe('an entry swallows a fragment of itself', () => {
  it('the measured case: a 34x137 box inside a 452x420 parked motorcycle', () => {
    expect(entrySwallowsDetection(BIKE, FRAGMENT)).toBe(true)
  })

  it('a box that merely OVERLAPS the entry is not a fragment of it', () => {
    expect(entrySwallowsDetection(BIKE, { x: 3400, y: 600, w: 300, h: 300 })).toBe(false)
  })

  it('a box of comparable size is not a fragment — that is the IoU case', () => {
    // 0.9x the entry, wholly inside: IoU 0.9 already answers this, and calling
    // it a fragment would let the two rules disagree about one box.
    expect(entrySwallowsDetection(BIKE, { ...BIKE, w: BIKE.w * 0.95, h: BIKE.h * 0.95 })).toBe(
      false,
    )
  })

  it('a box that pokes OUT of the entry is not contained', () => {
    expect(entrySwallowsDetection(BIKE, { x: BIKE.x + 400, y: BIKE.y, w: 120, h: 60 })).toBe(false)
  })
})
