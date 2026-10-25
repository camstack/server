/**
 * The FIRST observation of a key seeds it. It never fires.
 *
 * ## The bug this pins
 *
 * A key with no state used to start at `confirmedCount: 0, occupied: false` —
 * a fabricated "the zone is empty" that no snapshot ever said. The very first
 * snapshot then read as a 0→N transition and, after the sustain window, fired
 * a became-occupied edge for a scene that had not changed at all.
 *
 * Live cost, 2026-08-12: the operator created a became-occupied rule on zone
 * "Parking pat'" (device 102, class `car`) while the car was ALREADY
 * parked there. The cold baseline said free, so the next analysis pass would
 * have announced "Pat è tornato" for a car that never moved.
 *
 * ## The rule
 *
 * An edge may only arise from a TRANSITION BETWEEN TWO OBSERVED SNAPSHOTS.
 * One snapshot is a level, not a change: the first one for a key is written
 * into the state as-is — count, predicate, members — and no pending edge is
 * opened. The sustain/debounce machinery is untouched; seeding simply is not a
 * change, so there is nothing for it to confirm.
 *
 * A durable row still WINS: `hydrate` puts state in the map, so a key that was
 * reseeded on boot is not cold and takes the ordinary transition path. Only a
 * key with neither a durable row nor RAM state seeds silently.
 */

import type { CameraOccupancySnapshot } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { occupancyKey, OccupancyWatcher, type OccupancyStateRow } from '../occupancy-watcher.js'

const DEVICE = 102
const ZONE = 'zone-parking'
const SEC = 1_000
const SUSTAIN = 5

/** One zone holding `cars` cars, as ZoneAnalytics would report it. */
function parking(cars: number, trackIds: readonly string[] = []): CameraOccupancySnapshot {
  return {
    ts: 0,
    frameWidth: 1920,
    frameHeight: 1080,
    frame: { totalObjects: cars, byClass: { car: cars } },
    zones: [
      {
        zoneId: ZONE,
        zoneName: "Parking pat'",
        totalObjects: cars,
        byClass: { car: cars },
        trackIds: [...trackIds],
      },
    ],
    unzoned: { totalObjects: 0, byClass: {} },
  }
}

function watcherForParking(): OccupancyWatcher {
  const watcher = new OccupancyWatcher()
  watcher.setWatchedKeys([
    { zoneId: ZONE, className: 'car', threshold: 1, sustainSeconds: SUSTAIN },
  ])
  return watcher
}

/** Feed the same snapshot repeatedly, well past the sustain window. */
function observeFor(
  watcher: OccupancyWatcher,
  snap: CameraOccupancySnapshot,
  from: number,
  seconds: number,
): readonly ReturnType<OccupancyWatcher['observe']>[number][] {
  const edges = []
  for (let t = 0; t <= seconds; t += 1) {
    edges.push(...watcher.observe(DEVICE, snap, from + t * SEC))
  }
  return edges
}

describe('a cold occupancy key seeds from its first snapshot', () => {
  it('does NOT fire became-occupied for a car that was already parked', () => {
    const watcher = watcherForParking()

    // The rule is created while the car is in the zone. Every snapshot from now
    // on says "1 car", forever — nothing has changed, so nothing may fire.
    const edges = observeFor(watcher, parking(1, ['track-parked']), 0, SUSTAIN * 3)

    expect(edges).toEqual([])
  })

  it('seeds the state as OCCUPIED, so the level is right from the first sample', () => {
    const watcher = watcherForParking()
    watcher.observe(DEVICE, parking(1, ['track-parked']), 0)

    const row = watcher.snapshotState().find((r) => r.key === occupancyKey(DEVICE, ZONE, 'car', 1))
    expect(row).toBeDefined()
    expect(row?.occupied).toBe(true)
    expect(row?.confirmedCount).toBe(1)
    expect(row?.lastChangeAt).toBe(0)
  })

  it('fires became-free normally on the first REAL transition after the seed', () => {
    const watcher = watcherForParking()

    // Seed: the car is already there.
    observeFor(watcher, parking(1, ['track-parked']), 0, SUSTAIN * 2)
    // It drives away — a transition between two observed snapshots.
    const edges = observeFor(watcher, parking(0), 60 * SEC, SUSTAIN * 2)

    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      deviceId: DEVICE,
      zoneId: ZONE,
      className: 'car',
      occupied: false,
      count: 0,
      previousCount: 1,
      threshold: 1,
    })
  })

  it('still fires became-occupied when the seed was genuinely free', () => {
    const watcher = watcherForParking()

    // Seed: empty parking space.
    observeFor(watcher, parking(0), 0, SUSTAIN * 2)
    // The car arrives.
    const edges = observeFor(watcher, parking(1, ['track-arriving']), 60 * SEC, SUSTAIN * 2)

    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      occupied: true,
      count: 1,
      previousCount: 0,
      threshold: 1,
      mediaTrackId: 'track-arriving',
    })
  })

  it('holds the seed until the sustain window is met, exactly like any level', () => {
    const watcher = watcherForParking()
    observeFor(watcher, parking(0), 0, SUSTAIN * 2)

    // Arrival that flips back before the window closes: no edge, as always.
    watcher.observe(DEVICE, parking(1, ['track-passing']), 60 * SEC)
    watcher.observe(DEVICE, parking(1, ['track-passing']), 62 * SEC)
    const edges = watcher.observe(DEVICE, parking(0), 63 * SEC)

    expect(edges).toEqual([])
  })

  it('leaves the durable boot reseed in charge — a hydrated key is not cold', () => {
    const watcher = watcherForParking()
    const key = occupancyKey(DEVICE, ZONE, 'car', 1)
    // The crash happened while the space was FREE and that was confirmed.
    const rows: readonly OccupancyStateRow[] = [
      {
        key,
        deviceId: DEVICE,
        zoneId: ZONE,
        className: 'car',
        threshold: 1,
        confirmedCount: 0,
        occupied: false,
        lastChangeAt: 0,
        updatedAt: 0,
      },
    ]
    watcher.hydrate(rows)

    // Post-boot the car is there. Against the DURABLE row this is a real
    // transition, so it must fire — seeding must not swallow it.
    const edges = observeFor(watcher, parking(1, ['track-arrived']), 60 * SEC, SUSTAIN * 2)

    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ occupied: true, previousCount: 0 })
  })

  it('seeds each threshold of the same zone independently', () => {
    const watcher = new OccupancyWatcher()
    watcher.setWatchedKeys([
      { zoneId: ZONE, className: 'car', threshold: 1, sustainSeconds: SUSTAIN },
      { zoneId: ZONE, className: 'car', threshold: 3, sustainSeconds: SUSTAIN },
    ])

    // Two cars already parked: the ≥1 key seeds occupied, the ≥3 key seeds free.
    const edges = observeFor(watcher, parking(2, ['a', 'b']), 0, SUSTAIN * 2)
    expect(edges).toEqual([])

    const rows = watcher.snapshotState()
    expect(rows.find((r) => r.threshold === 1)?.occupied).toBe(true)
    expect(rows.find((r) => r.threshold === 3)?.occupied).toBe(false)

    // A third car arrives — only the ≥3 key crosses.
    const later = observeFor(watcher, parking(3, ['a', 'b', 'c']), 60 * SEC, SUSTAIN * 2)
    expect(later).toHaveLength(1)
    expect(later[0]).toMatchObject({ threshold: 3, occupied: true })
  })

  it('a key that becomes watched later seeds from its own first snapshot', () => {
    const watcher = new OccupancyWatcher()
    // Watching ≥3 while one car sits there: that key seeds FREE.
    watcher.setWatchedKeys([
      { zoneId: ZONE, className: 'car', threshold: 3, sustainSeconds: SUSTAIN },
    ])
    observeFor(watcher, parking(1, ['track-parked']), 0, SUSTAIN * 2)

    // The operator edits the rule to ≥1 — a DIFFERENT key, therefore cold, and
    // one whose predicate is already true for the unchanged scene. The car
    // still has not moved, so this must stay silent.
    watcher.setWatchedKeys([
      { zoneId: ZONE, className: 'car', threshold: 1, sustainSeconds: SUSTAIN },
    ])
    const edges = observeFor(watcher, parking(1, ['track-parked']), 60 * SEC, SUSTAIN * 2)

    expect(edges).toEqual([])
  })
})
