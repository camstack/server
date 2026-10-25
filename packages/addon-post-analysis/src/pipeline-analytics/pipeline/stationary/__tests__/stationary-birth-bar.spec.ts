/**
 * A stationary birth is refused for ONE reason: the box is an artifact.
 *
 * What this file used to pin (D497) — an AREA bar at 0.30 of the frame, and
 * then a second door through it for boxes whose evidence was "mostly burst" —
 * is gone, and the record of why is in `stationary-birth-guard.ts` and D508:
 * the area bar refused the operator's own car (0.360) twelve times in twelve
 * hours while the ghost that motivated it measured 0.361, and the burst door
 * was measuring a runner label that filed every live session frame as a burst.
 *
 * Two rules are pinned here instead:
 *
 *  1. the artifact rule refuses a near-full-frame or full-dimension box, with
 *     any evidence behind it — 3836's jacket on its coat stand, 1132x1396 in a
 *     2560x1440 frame, 40 486 agreements — and it is asked INSIDE the ledger's
 *     verdict, so a refused candidate keeps its evidence;
 *  2. size decides nothing at birth. The oversize case is answered in the
 *     matcher (`OVERSIZE_AREA_FRAC`, see `stationary-match.spec.ts`), and the
 *     registry needs no list of who may absorb whom: the same predicate that
 *     stops an oversize entry holding a fragment stops it absorbing one.
 */
import { makeAnalyticsRecordsNow, type FakeRecords } from '../../../__tests__/fake-records.js'
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { createNoopLogger } from '../../../../embedding-encoder/shared/noop-logger.js'
import { boxAreaFraction, isPlausibleStationaryBirthBox } from '../stationary-birth-guard.js'
import { OVERSIZE_AREA_FRAC } from '../stationary-match.js'
import { StationaryObjectRegistry } from '../stationary-registry.js'
import type { StationaryBbox, StationaryEntry } from '../stationary-types.js'

const FRAME_W = 3840
const FRAME_H = 2160

/** The real 102 ghost: 1669x1796 of a 4K frame, 0.361. */
const EXPLODED: StationaryBbox = { x: 1000, y: 200, w: 1669, h: 1796 }
/** A genuine parked motorcycle sitting wholly inside it. */
const BIKE: StationaryBbox = { x: 1400, y: 900, w: 452.4, h: 420 }
/** The operator's own parked car on 102 — 0.360, the same number. */
const OPERATOR_CAR: StationaryBbox = { x: 591.6, y: 57.6, w: 1735.2, h: 1720.8 }
/** A normal parked object, 0.034 of the frame. */
const CAR: StationaryBbox = { x: 3476.4, y: 694.8, w: 360, h: 774 }
/** 3836's jacket: 97 % of a 1440-high frame. */
const JACKET: StationaryBbox = { x: 268, y: 0, w: 1132, h: 1396 }

const T0 = 1_789_000_000_000

function entry(over: Partial<StationaryEntry> = {}): StationaryEntry {
  return {
    id: over.id ?? 'e1',
    deviceId: over.deviceId ?? 102,
    className: over.className ?? 'vehicle',
    bbox: over.bbox ?? CAR,
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    firstSeenAt: over.firstSeenAt ?? T0,
    becameStationaryAt: over.becameStationaryAt ?? T0,
    lastConfirmedAt: over.lastConfirmedAt ?? T0,
    ...(over.label !== undefined ? { label: over.label } : {}),
  }
}

describe('the stationary BIRTH bar is the artifact rule, and only that', () => {
  it('refuses the jacket — a box spanning 97 % of the frame height', () => {
    expect(isPlausibleStationaryBirthBox(JACKET, 2560, 1440)).toBe(false)
  })

  it('refuses a near-full-frame envelope', () => {
    expect(isPlausibleStationaryBirthBox({ w: 3600, h: 2000 }, FRAME_W, FRAME_H)).toBe(false)
  })

  // THE measurement D497 could not act on: the car and the ghost are one
  // thousandth apart in area, so neither is refused on size — the ghost is
  // answered by the matcher's reach rule, not by refusing it a row.
  it("admits the operator's car AND the 0.361 ghost alike — size decides nothing", () => {
    expect(boxAreaFraction(OPERATOR_CAR, FRAME_W, FRAME_H)).toBeCloseTo(0.36, 2)
    expect(boxAreaFraction(EXPLODED, FRAME_W, FRAME_H)).toBeCloseTo(0.361, 3)
    expect(isPlausibleStationaryBirthBox(OPERATOR_CAR, FRAME_W, FRAME_H)).toBe(true)
    expect(isPlausibleStationaryBirthBox(EXPLODED, FRAME_W, FRAME_H)).toBe(true)
    // …and both are oversize for the MATCHER, which is where they are held
    // on strong reads only.
    expect(boxAreaFraction(OPERATOR_CAR, FRAME_W, FRAME_H)).toBeGreaterThanOrEqual(
      OVERSIZE_AREA_FRAC,
    )
    expect(boxAreaFraction(EXPLODED, FRAME_W, FRAME_H)).toBeGreaterThanOrEqual(OVERSIZE_AREA_FRAC)
  })

  it('accepts a normal parked object', () => {
    expect(isPlausibleStationaryBirthBox(CAR, FRAME_W, FRAME_H)).toBe(true)
  })

  it('has no opinion when the frame size is unknown', () => {
    expect(isPlausibleStationaryBirthBox(JACKET, 0, 0)).toBe(true)
    expect(boxAreaFraction(JACKET, 0, 0)).toBe(0)
  })
})

/**
 * The birth path in `pipeline-analytics/index.ts` has NO gate of its own: the
 * ledger decides plausibility inside its verdict, and the birth site would be
 * a second authority. Pinned on the source because `index.ts` is 16k lines and
 * has no harness — this is the same style the previous version of this spec
 * used, for the same reason.
 */
describe('the birth path trusts the ledger (pipeline-analytics/index.ts)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../../index.ts'), 'utf-8')
  const start = src.indexOf('private birthStationaryFromEvidence(input: {')
  const body = src.slice(start, start + 12_000)

  it('has no admission of its own — no thumbnail guard, no area bar, no burst door', () => {
    expect(start).toBeGreaterThan(0)
    expect(body).not.toContain('stationaryBirthAdmission(')
    expect(body).not.toContain('isPlausibleThumbnailBox(')
    expect(body).not.toContain('isPlausibleStationaryBirthBox(')
    expect(body).not.toContain('BIRTH_MAX_AREA_FRAC')
  })

  it('hands the ledger the frame the artifact rule needs, on every observation', () => {
    const loop = src.indexOf('const observation: StationaryObservation = {')
    expect(loop).toBeGreaterThan(0)
    const block = src.slice(loop, loop + 1_500)
    expect(block).toContain('frameWidth: result.frameWidth')
    expect(block).toContain('frameHeight: result.frameHeight')
  })

  it('offers no evidence from a coasted frame, and names the verdict by occasion', () => {
    const loop = src.indexOf(
      'for (const t of result.tracked) {\n        if (packageClasses.has(t.className)) continue',
    )
    expect(loop).toBeGreaterThan(0)
    const block = src.slice(loop, loop + 1_200)
    expect(block).toContain('if (!trackOffersEvidence(t)) continue')
    expect(block).toContain('stillnessVerdictFor(occasion, t.state)')
  })

  it('logs the birth with how big the box is, since size no longer decides', () => {
    // D683 Task 14 fix round 1 (L3): ONE birth line, logged once the
    // promoted tracks are settled; its meta is the `birth` record.
    const born = body.indexOf('stationary entry born from repeated evidence')
    expect(born).toBeGreaterThan(0)
    expect(body.slice(born, born + 400)).toContain('...birth,')
    const record = body.indexOf('const birth = {')
    expect(record).toBeGreaterThan(0)
    const fields = body.slice(record, record + 1_400)
    expect(fields).toContain('areaFrac')
    expect(fields).toContain('oversize:')
  })
})

/**
 * The registry no longer keeps a list of who may absorb whom (`censusTenants`
 * is gone). The invariant D495 wanted — an oversize row may not eat a
 * genuinely different neighbour — now follows from the matcher's own
 * predicate, which the registry has always used.
 */
describe('an oversize row absorbs nothing but its own box', () => {
  let world: FakeRecords
  let reg: StationaryObjectRegistry

  beforeEach(async () => {
    world = makeAnalyticsRecordsNow()
    reg = new StationaryObjectRegistry({ records: world.records, logger: createNoopLogger() })
  })

  it('the 102 loss: the sweep keeps the motorcycle out of the exploded box', async () => {
    await reg.promote(entry({ id: 'exploded', bbox: EXPLODED, becameStationaryAt: T0 }))
    await reg.promote(entry({ id: 'bike', bbox: BIKE, becameStationaryAt: T0 + 60_000 }))
    expect(reg.count(102)).toBe(2)

    reg.noteFrame(102, T0 + 120_000)
    await reg.sweep(T0 + 120_000)

    expect(
      reg
        .list(102)
        .map((e) => e.id)
        .toSorted(),
    ).toEqual(['bike', 'exploded'])
  })

  it('a promotion onto the exploded box is BORN, not merged into it', async () => {
    await reg.promote(entry({ id: 'exploded', bbox: EXPLODED }))
    const bike = await reg.promote(entry({ id: 'bike', bbox: BIKE, becameStationaryAt: T0 + 1000 }))
    expect(bike.outcome).toBe('born')
    expect(reg.count(102)).toBe(2)
  })

  // Its OWN duplicate is still one spot, one row: the operator's car was
  // promoted again roughly once an hour and must not multiply.
  it("the operator's oversize car still absorbs its own re-promotion", async () => {
    await reg.promote(entry({ id: 'car', bbox: OPERATOR_CAR, becameStationaryAt: T0 }))
    const again = await reg.promote(
      entry({ id: 'car-again', bbox: OPERATOR_CAR, becameStationaryAt: T0 + 3_600_000 }),
    )
    expect(again.outcome).toBe('merged')
    expect(reg.count(102)).toBe(1)
  })

  // The control: a normal-sized tenant still collapses its duplicate on sweep.
  it('a normal parked row still collapses its duplicate', async () => {
    await reg.promote(entry({ id: 'car', bbox: CAR, becameStationaryAt: T0 }))
    await reg.promote(entry({ id: 'car-again', bbox: CAR, becameStationaryAt: T0 + 60_000 }), {
      suppressIou: 2,
      wakeAssocIou: 2,
    })
    expect(reg.count(102)).toBe(2)

    reg.noteFrame(102, T0 + 120_000)
    await reg.sweep(T0 + 120_000)
    expect(reg.list(102).map((e) => e.id)).toEqual(['car'])
  })
})
