/**
 * A detection refused inside a watched zone is OBSERVED. It never becomes an
 * event, and therefore can never become a notification.
 *
 * ## What the previous shape cost, measured
 *
 * On 2026-09-09 this path was built the other way: a refused detection inside
 * a zone emitted a real `ObjectEvent` carrying its overlap percentage, so a
 * zone-scoped immediate rule could answer "is there an animal in the flowerbed
 * NOW?" without waiting for a track. Ten hours of production on this hub said
 * that was wrong, three times over:
 *
 *  - **The population is stationary junk.** 1511 such events on camera 101, of
 *    which **1473 were `className=package`** — one parcel sitting at the door,
 *    inside "Uscio" at 100% overlap, re-offered on EVERY analysed frame. On
 *    102 the same shape was a parked car under `stationary-hold`, peaking at
 *    19 events/second. A refused box is refused on every frame of a passage,
 *    so a subject that never leaves is an unbounded emitter.
 *  - **Both notifications it ever produced were false.** Two `animal` events
 *    reached the rule "Animale su Aiuola" (22:53:28 and 07:10:24). The
 *    operator confirmed there was no animal in either. The confirmation gate
 *    had refused them BECAUSE they were phantoms — the guard was right, and
 *    this path overrode a correct judgement.
 *  - **They could not even be stored.** `object-events.trackId` is
 *    `notNull: true`; every insert failed (589 in ten hours), was swallowed by
 *    `insertObject`'s warn, and `onObjectEventPersisted` then fired on a row
 *    that did not exist — so the two notifications shipped text-only, with no
 *    still to show.
 *
 * And the miss that motivated the whole thing was never of this kind. The cat
 * of 2026-09-10 05:55:45 was NOT refused: it was confirmed (`native-pass`,
 * 0.8285), tracked, and stamped in "Uscio" at 100%. It went unannounced
 * because the operator has a rule for animals in *Aiuola* and one for persons
 * on *Uscio*, and none for an animal on the doorstep. No amount of emitting
 * refusals would have reached it.
 *
 * ## The rule this pins
 *
 * The confirmation gate's verdict is final for ALERTING. A refusal is
 * diagnostic evidence — it tells us where a missed subject would show up — and
 * diagnostic evidence goes to an observer the addon logs, never into the event
 * stream that rules read. Nothing downstream can turn it into an alert,
 * because there is nothing downstream.
 *
 * Identical refusals are collapsed for a throttle window: a stationary subject
 * is refused on every frame, and an unthrottled diagnostic line is the same
 * storm written to a different file.
 */
import type { FrameResult, ObjectDetection, Zone } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { ZoneRefusalObservation } from '../frame-processor.js'
import { FrameProcessor } from '../frame-processor.js'

const DEVICE = 101
const FRAME = { width: 3840, height: 2160 }

/** The operator's real zone, read from the hub on 2026-09-09. */
const AIUOLA: Zone = {
  id: 'fa03b60a-5669-4a8a-976b-bac422f5f530',
  name: 'Aiuola',
  kind: 'polygon',
  color: '#3b82f6',
  polygon: [
    { x: 0.518, y: 0.218 },
    { x: 0.951, y: 0.218 },
    { x: 0.951, y: 0.693 },
    { x: 0.518, y: 0.693 },
  ],
}

/** The measured dog: 0.7729, x=3237 y=101 157×146 — wholly inside the zone. */
function dogInTheFlowerbed(): ObjectDetection {
  return {
    id: 'a62695fe',
    kind: 'first-level',
    macroClass: 'animal',
    score: 0.7729,
    labels: [],
    bbox: { x: 3237, y: 615.625, width: 157.25, height: 146.25 },
    debug: { originalClass: 'dog' },
  }
}

function frame(detections: readonly ObjectDetection[], timestamp: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE,
    timestamp,
    width: FRAME.width,
    height: FRAME.height,
    detections,
  }
}

/** One sighting, then silence — the shape that produced `measured=1`. */
function seeOnceThenLoseIt(processor: FrameProcessor): ReturnType<FrameProcessor['process']>[] {
  const out: ReturnType<FrameProcessor['process']>[] = []
  out.push(processor.process({ timestamp: 1_000, frame: frame([dogInTheFlowerbed()], 1_000) }))
  for (let i = 1; i <= 40; i++) {
    const t = 1_000 + i * 500
    out.push(processor.process({ timestamp: t, frame: frame([], t) }))
  }
  return out
}

function observing(processor: FrameProcessor): ZoneRefusalObservation[] {
  const seen: ZoneRefusalObservation[] = []
  processor.setZoneRefusalObserver((o) => seen.push(o))
  return seen
}

describe('a detection the tracker refused, inside a watched zone', () => {
  it('produces NO event — nothing a rule could ever read', () => {
    const processor = new FrameProcessor(DEVICE, { minHits: 3 })
    processor.setZones([AIUOLA])
    observing(processor)

    const events = seeOnceThenLoseIt(processor).flatMap((r) => [
      ...r.objectEvents,
      ...r.appearanceEvents,
    ])

    expect(
      events.filter((e) => e.className === 'animal'),
      'a refused detection reached the event stream, where a rule can alert on it',
    ).toHaveLength(0)
  })

  it('every event that IS emitted carries a trackId, so the store can hold it', () => {
    const processor = new FrameProcessor(DEVICE, { minHits: 3 })
    processor.setZones([AIUOLA])
    observing(processor)

    const events = seeOnceThenLoseIt(processor).flatMap((r) => [
      ...r.objectEvents,
      ...r.appearanceEvents,
    ])

    // `object-events.trackId` is notNull. An event without one is 589 swallowed
    // insert failures and a notification fired on a row that does not exist.
    expect(events.filter((e) => e.trackId === undefined)).toHaveLength(0)
  })

  it('reports the refusal to the observer, with the zone and how far inside it was', () => {
    const processor = new FrameProcessor(DEVICE, { minHits: 3 })
    processor.setZones([AIUOLA])
    const seen = observing(processor)

    seeOnceThenLoseIt(processor)

    const animal = seen.find((o) => o.className === 'animal')
    expect(animal, 'the refused dog was not observed at all').toBeDefined()
    expect(animal?.reason).toBe('unconfirmed-spawn-lost')
    const overlap = (animal?.zones ?? []).find((z) => z.zoneId === AIUOLA.id)
    expect(overlap, 'the observation carries no overlap percentage').toBeDefined()
    expect(overlap?.overlapPct).toBeCloseTo(100, 0)
  })

  it('collapses a repeated identical refusal instead of reporting each one', () => {
    const processor = new FrameProcessor(DEVICE, { minHits: 3 })
    processor.setZones([AIUOLA])
    const seen = observing(processor)

    // Two passages of the SAME box, close in time — the parcel at the door
    // that is refused, forgotten, and refused again. Unthrottled this is the
    // 19-events/second storm measured on 102.
    let t = 1_000
    for (let pass = 0; pass < 2; pass++) {
      processor.process({ timestamp: t, frame: frame([dogInTheFlowerbed()], t) })
      for (let i = 1; i <= 40; i++) {
        t += 500
        processor.process({ timestamp: t, frame: frame([], t) })
      }
      t += 500
    }

    // Both refusals are COUNTED — the volume measure describes what happened.
    expect(
      processor.zoneRefusalEventsEmitted(),
      'the second refusal was not counted',
    ).toBeGreaterThanOrEqual(2)
    // Only one is REPORTED — the log line describes what is worth reading.
    expect(seen, `an identical refusal was reported ${seen.length} times`).toHaveLength(1)
  })

  it('reports again once the throttle window has passed', () => {
    const processor = new FrameProcessor(DEVICE, { minHits: 3 })
    processor.setZones([AIUOLA])
    const seen = observing(processor)

    let t = 1_000
    for (let pass = 0; pass < 2; pass++) {
      processor.process({ timestamp: t, frame: frame([dogInTheFlowerbed()], t) })
      for (let i = 1; i <= 40; i++) {
        t += 500
        processor.process({ timestamp: t, frame: frame([], t) })
      }
      // A subject that comes back much later is news again, not a repeat.
      t += 120_000
    }

    expect(seen, 'a subject returning after the window was silently swallowed').toHaveLength(2)
  })
})
