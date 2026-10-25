/**
 * Two hundredths of IoU held a camera hostage for eight and a half hours.
 *
 * Entry `02e6bf01` on device 102 was anchored at promotion on its source
 * track's last box — 406x1103, inflated by a merged frame. The car's real
 * reading is 399x814: the same object, in the same place, at IoU ≈ 0.58
 * against a `suppressIou` of 0.60.
 *
 * Every reading of that car was therefore WEAK, and "a weak hold never
 * re-anchors" meant nothing could correct it. The entry never suppressed
 * strongly, so the car minted a track a minute; and a weak hold is CONTINUABLE,
 * so passers-by latched onto the parked box and froze there — 1 330 weak holds
 * consumed by confirmed tracks in 12 h, against 0 on a healthy camera.
 *
 * The rule: a weak box seen AGAIN, in the SAME PLACE, for long enough, stops
 * being evidence about the anchor's neighbourhood and becomes evidence about
 * the anchor. A lorry crossing the spot does not qualify, because it moves.
 */
import { makeAnalyticsRecordsNow } from '../../../__tests__/fake-records.js'
import { describe, expect, it } from 'vitest'

import { createNoopLogger } from '../../../../embedding-encoder/shared/noop-logger.js'
import { StationaryObjectRegistry } from '../stationary-registry.js'
import {
  STALE_ANCHOR_MIN_IOU,
  STALE_ANCHOR_MIN_OBSERVED_MS,
  stepStaleAnchor,
  type WeakRun,
} from '../stale-anchor.js'
import type { StationaryBbox } from '../stationary-types.js'

/** The real reading of the operator's car, to the pixel. */
const CAR: StationaryBbox = { x: 3433, y: 704, w: 399, h: 814 }
const SEC = 1_000

function runOf(bbox: StationaryBbox, since: number, seen = 1): WeakRun {
  return { bbox, since, seen }
}

describe('a repeated weak reading corrects the anchor', () => {
  // A single reading is exactly what this rule refuses to act on: one frame is
  // how a bad anchor would be replaced by a passing lorry.
  it('never re-anchors on a first sighting', () => {
    const step = stepStaleAnchor(undefined, CAR, 0)
    expect(step.kind).toBe('hold')
  })

  it('holds while the run is younger than the bound', () => {
    const step = stepStaleAnchor(runOf(CAR, 0), CAR, STALE_ANCHOR_MIN_OBSERVED_MS - SEC)
    expect(step.kind).toBe('hold')
    expect(step.kind === 'hold' && step.run.seen).toBe(2)
    // The run keeps its ORIGIN: restarting the clock on every agreeing reading
    // would mean it never matures.
    expect(step.kind === 'hold' && step.run.since).toBe(0)
  })

  it('re-anchors once the same box has held long enough', () => {
    const step = stepStaleAnchor(runOf(CAR, 0), CAR, STALE_ANCHOR_MIN_OBSERVED_MS)
    expect(step.kind).toBe('reanchor')
    expect(step.kind === 'reanchor' && step.bbox).toEqual(CAR)
  })

  // THE CONTROL, and the reason this cannot simply loosen `suppressIou`: a box
  // that MOVES has disproved the whole argument, however long it has been
  // around. Dropped, not decayed.
  it('resets when the reading moves', () => {
    const moved: StationaryBbox = { ...CAR, x: CAR.x + 300 }
    expect(stepStaleAnchor(runOf(CAR, 0), moved, 10 * SEC).kind).toBe('reset')
  })

  // Relative to the subject, per D394/D400: 8 px is a fifth of a person and a
  // rounding error on a 2779x1572 SUV, so an absolute bound cannot serve both.
  it('tolerates jitter in proportion to the subject, not in absolute pixels', () => {
    const SUV: StationaryBbox = { x: 100, y: 100, w: 2779, h: 1572 }
    // ~1% of the SUV's diagonal is ~32 px: jitter for it…
    const suvJitter: StationaryBbox = { ...SUV, x: SUV.x + 20 }
    expect(stepStaleAnchor(runOf(SUV, 0), suvJitter, SEC).kind).toBe('hold')
    // …and a real move for the much smaller car.
    const carMoved: StationaryBbox = { ...CAR, x: CAR.x + 20 }
    expect(stepStaleAnchor(runOf(CAR, 0), carMoved, SEC).kind).toBe('reset')
  })

  // A tiny box must still get a usable allowance, or sub-pixel noise resets it
  // on every frame and no run ever matures.
  it('keeps an absolute floor for a very small box', () => {
    const tiny: StationaryBbox = { x: 10, y: 10, w: 20, h: 20 }
    const nudged: StationaryBbox = { ...tiny, x: 12 }
    expect(stepStaleAnchor(runOf(tiny, 0), nudged, SEC).kind).toBe('hold')
  })

  // The clock is the OBSERVED one. A camera that was dark for an hour has not
  // observed anything, and a run must not mature on a gap — the same lesson
  // D501 took from the retirement side.
  it('does not mature on a clock that went backwards', () => {
    expect(stepStaleAnchor(runOf(CAR, 10 * SEC), CAR, 0).kind).toBe('hold')
  })
})

/**
 * The registry end to end — a real entry, a real inflated anchor, real weak
 * confirmations.
 *
 * A structural assertion was written here first and it did NOT bite:
 * neutralising the re-anchor left the log string sitting in a dead branch and
 * every check still passed. A test that survives the removal of the thing it
 * guards is worse than no test, so this drives the object instead.
 */
/**
 * The time bound alone was not enough, and production said so within the hour.
 *
 * On `Camera studio`, a `person` entry of 236x568 was re-anchored onto a
 * 1094x1406 box — eleven times the area, IoU 0.087. That is not an anchor that
 * is slightly wrong: it is a different object standing in front of the entry
 * long enough to steal it. The rule this replaced refused exactly that, by
 * never letting a weak read anchor at all, and the correction had thrown the
 * protection out with it.
 */
describe('a correction must still be the anchor’s own object', () => {
  const PERSON: StationaryBbox = { x: 1012.8, y: 379.2, w: 236.8, h: 568.8 }
  /** The box that stole it, to the decimal. */
  const STANDING_IN_FRONT: StationaryBbox = { x: 301.6, y: 2.4, w: 1094.4, h: 1406.4 }

  it('refuses the measured theft, however long it stands there', () => {
    const run = runOf(STANDING_IN_FRONT, 0, 99)
    const step = stepStaleAnchor(
      run,
      STANDING_IN_FRONT,
      10 * STALE_ANCHOR_MIN_OBSERVED_MS,
      undefined,
      PERSON,
    )
    expect(step.kind).toBe('reset')
  })

  // THE CASE THIS EXISTS FOR must still pass: 102's anchor was two hundredths
  // below `suppressIou`, which is a wrong box, not a wrong object.
  it('still admits a box that is merely a little wrong', () => {
    const INFLATED: StationaryBbox = { x: 3433, y: 704, w: 406, h: 1103 }
    const step = stepStaleAnchor(
      runOf(CAR, 0),
      CAR,
      STALE_ANCHOR_MIN_OBSERVED_MS,
      undefined,
      INFLATED,
    )
    expect(step.kind).toBe('reanchor')
  })

  // The floor sits BELOW the suppression bar on purpose: above it a read
  // already re-anchors outright and needs none of this.
  it('sits below the bar it exists to reach under', () => {
    expect(STALE_ANCHOR_MIN_IOU).toBeLessThan(0.6)
    expect(STALE_ANCHOR_MIN_IOU).toBeGreaterThan(0.087)
  })
})

describe('the registry corrects an inflated anchor', () => {
  const DEVICE = 102
  /** 102's real entry, anchored on its source track's merged box. */
  const INFLATED: StationaryBbox = { x: 3433, y: 704, w: 406, h: 1103 }

  async function registryWithInflatedEntry(): Promise<{
    reg: StationaryObjectRegistry
    entryId: string
  }> {
    const world = makeAnalyticsRecordsNow()
    const reg = new StationaryObjectRegistry({ records: world.records, logger: createNoopLogger() })
    const promotion = await reg.promote({
      id: 'e-inflated',
      deviceId: DEVICE,
      className: 'vehicle',
      bbox: INFLATED,
      frameWidth: 3840,
      frameHeight: 2160,
      firstSeenAt: 0,
      becameStationaryAt: 0,
      lastConfirmedAt: 0,
    })
    return { reg, entryId: promotion.entry.id }
  }

  /** One weak confirmation of the car's REAL box. */
  function weakly(entryId: string, at: number) {
    return {
      deviceId: DEVICE,
      timestamp: at,
      woken: [],
      confirmed: [
        { entryId, className: 'vehicle', bbox: INFLATED, observedBbox: CAR, strong: false },
      ],
    } as Parameters<StationaryObjectRegistry['applyFrameOutcome']>[0]
  }

  it('re-anchors onto the box the weak read keeps reporting', async () => {
    const { reg, entryId } = await registryWithInflatedEntry()
    reg.applyFrameOutcome(weakly(entryId, 0))
    // Not yet: a run younger than the bound must not move the anchor.
    reg.applyFrameOutcome(weakly(entryId, 10 * SEC))
    expect(reg.list(DEVICE)[0]?.bbox).toEqual(INFLATED)

    reg.applyFrameOutcome(weakly(entryId, STALE_ANCHOR_MIN_OBSERVED_MS))
    expect(reg.list(DEVICE)[0]?.bbox).toEqual(CAR)
  })

  // THE CONTROL. A box that crosses the spot and moves on must never take the
  // anchor with it — that is what "a weak hold never re-anchors" was protecting,
  // and it still holds for everything that actually moves.
  it('a passing box that MOVES never takes the anchor', async () => {
    const { reg, entryId } = await registryWithInflatedEntry()
    for (const [i, at] of [0, 10 * SEC, 20 * SEC, 40 * SEC].entries()) {
      const drifting: StationaryBbox = { ...CAR, x: CAR.x + i * 250 }
      reg.applyFrameOutcome({
        deviceId: DEVICE,
        timestamp: at,
        woken: [],
        confirmed: [
          {
            entryId,
            className: 'vehicle',
            bbox: INFLATED,
            observedBbox: drifting,
            strong: false,
          },
        ],
      } as Parameters<StationaryObjectRegistry['applyFrameOutcome']>[0])
    }
    expect(reg.list(DEVICE)[0]?.bbox).toEqual(INFLATED)
  })
})
