/**
 * The cold seed is DURABLE, and an impossible class scope is LOUD.
 *
 * ## What was broken
 *
 * `seedState` fixed the "already-parked car announces its own arrival" bug by
 * writing the first observed level into RAM instead of a fabricated zero. Only
 * into RAM: `observe` did `states.set(seed)` and returned, while the durable
 * write-through fired on committed EDGES only. So every restart threw the
 * baseline away and re-seeded cold from whatever the first post-boot snapshot
 * said — and a hub that restarts is a hub whose occupancy history starts again.
 *
 * The seed is now handed back by {@link OccupancyWatcher.takeSeededRows} and
 * persisted by the caller through the SAME ledger the edges use, so a restart
 * rehydrates the baseline instead of inventing one.
 *
 * The invariant is unchanged and is asserted here: A SEED NEVER FIRES, and a
 * durable row still WINS (`hydrate` runs before the first `observe`, so a
 * hydrated key is never cold and never re-seeds).
 *
 * ## The second trap
 *
 * `byClass` is keyed on MACRO classes only. An occupancy key scoped to `car`
 * counts a key that does not exist — 0 forever, silently. Two live rules on
 * device 102 were authored that way (2026-08-12). The watcher now reports it
 * once per key so the log answers "this rule can never count".
 */

import type { CameraOccupancySnapshot } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  occupancyKey,
  OccupancyWatcher,
  type OccupancyImpossibleScope,
  type OccupancyStateRow,
} from '../occupancy-watcher.js'

const DEVICE = 102
const ZONE = 'zone-parking'
const SEC = 1_000
const SUSTAIN = 5
const KEY = occupancyKey(DEVICE, ZONE, 'vehicle', 1)

/** One zone holding `cars` vehicles, as ZoneAnalytics reports it — MACRO keyed,
 *  because that is the only vocabulary the snapshot has. */
function parking(cars: number, trackIds: readonly string[] = []): CameraOccupancySnapshot {
  return {
    ts: 0,
    frameWidth: 1920,
    frameHeight: 1080,
    frame: { totalObjects: cars, byClass: { vehicle: cars } },
    zones: [
      {
        zoneId: ZONE,
        zoneName: "Parking pat'",
        totalObjects: cars,
        byClass: { vehicle: cars },
        trackIds: [...trackIds],
      },
    ],
    unzoned: { totalObjects: 0, byClass: {} },
  }
}

function watcherForParking(className = 'vehicle'): OccupancyWatcher {
  const watcher = new OccupancyWatcher()
  watcher.setWatchedKeys([{ zoneId: ZONE, className, threshold: 1, sustainSeconds: SUSTAIN }])
  return watcher
}

describe('the cold seed is persisted', () => {
  it('hands back the seeded row on the observation that created it', () => {
    const watcher = watcherForParking()
    watcher.observe(DEVICE, parking(1, ['track-parked']), 10 * SEC)

    const seeded = watcher.takeSeededRows()
    expect(seeded).toHaveLength(1)
    expect(seeded[0]).toMatchObject({
      key: KEY,
      deviceId: DEVICE,
      zoneId: ZONE,
      className: 'vehicle',
      threshold: 1,
      confirmedCount: 1,
      occupied: true,
      lastChangeAt: 10 * SEC,
    })
  })

  it('drains — a row is offered once, never re-persisted per frame', () => {
    const watcher = watcherForParking()
    watcher.observe(DEVICE, parking(1, ['track-parked']), 0)
    expect(watcher.takeSeededRows()).toHaveLength(1)

    watcher.observe(DEVICE, parking(1, ['track-parked']), SEC)
    watcher.observe(DEVICE, parking(1, ['track-parked']), 2 * SEC)
    expect(watcher.takeSeededRows()).toEqual([])
  })

  it('offers nothing when the key was hydrated — a durable row wins', () => {
    const watcher = watcherForParking()
    const rows: readonly OccupancyStateRow[] = [
      {
        key: KEY,
        deviceId: DEVICE,
        zoneId: ZONE,
        className: 'vehicle',
        threshold: 1,
        confirmedCount: 0,
        occupied: false,
        lastChangeAt: 0,
        updatedAt: 0,
      },
    ]
    watcher.hydrate(rows)
    watcher.observe(DEVICE, parking(1, ['track-arrived']), 60 * SEC)

    expect(watcher.takeSeededRows()).toEqual([])
  })

  it('drops a seeded row whose key stopped being watched before the drain', () => {
    const watcher = watcherForParking()
    watcher.observe(DEVICE, parking(1, ['track-parked']), 0)
    // The operator edits the rule's threshold on the very next tick: the old
    // key is gone, and persisting it would only create a row for the next
    // prune to delete.
    watcher.setWatchedKeys([
      { zoneId: ZONE, className: 'vehicle', threshold: 3, sustainSeconds: 5 },
    ])

    expect(watcher.takeSeededRows()).toEqual([])
  })

  it('the seed still fires NOTHING — persisting it changes no edge', () => {
    const watcher = watcherForParking()
    const edges = []
    for (let t = 0; t <= SUSTAIN * 3; t += 1) {
      edges.push(...watcher.observe(DEVICE, parking(1, ['track-parked']), t * SEC))
    }
    expect(edges).toEqual([])
  })

  /**
   * THE POINT OF THE FIX, end to end. Neutralise it by not carrying the seeded
   * row across the restart and the second watcher seeds cold on the parked car,
   * so the car driving away produces nothing at all — the phantom re-seed.
   */
  it('survives a restart: the transition after the reboot still fires', () => {
    const before = watcherForParking()
    before.observe(DEVICE, parking(1, ['track-parked']), 0)
    const persisted = before.takeSeededRows()
    expect(persisted).toHaveLength(1)

    // ── restart ──
    const after = watcherForParking()
    after.hydrate(persisted)

    // The car leaves after the reboot. Against the rehydrated baseline that is
    // a genuine transition and must fire.
    const edges = []
    for (let t = 0; t <= SUSTAIN * 2; t += 1) {
      edges.push(...after.observe(DEVICE, parking(0), 60 * SEC + t * SEC))
    }
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ occupied: false, count: 0, previousCount: 1 })
  })

  it('without the carried row the same reboot goes silent (the bug, pinned)', () => {
    const after = watcherForParking()
    // No hydrate: the pre-restart seed was never persisted.
    const edges = []
    for (let t = 0; t <= SUSTAIN * 2; t += 1) {
      edges.push(...after.observe(DEVICE, parking(0), 60 * SEC + t * SEC))
    }
    // Re-seeded cold as FREE — the departure is invisible.
    expect(edges).toEqual([])
  })
})

describe('an impossible class scope is reported once per key', () => {
  it('reports a sub-type class — the counter can never be non-zero', () => {
    const onImpossibleScope = vi.fn<(scope: OccupancyImpossibleScope) => void>()
    const watcher = new OccupancyWatcher({ onImpossibleScope })
    watcher.setWatchedKeys([{ zoneId: ZONE, className: 'car', threshold: 1, sustainSeconds: 5 }])

    watcher.observe(DEVICE, parking(1, ['track-parked']), 0)

    expect(onImpossibleScope).toHaveBeenCalledTimes(1)
    expect(onImpossibleScope).toHaveBeenCalledWith({
      deviceId: DEVICE,
      key: occupancyKey(DEVICE, ZONE, 'car', 1),
      zoneId: ZONE,
      className: 'car',
      threshold: 1,
    })
  })

  it('reports ONCE, not once per snapshot', () => {
    const onImpossibleScope = vi.fn<(scope: OccupancyImpossibleScope) => void>()
    const watcher = new OccupancyWatcher({ onImpossibleScope })
    watcher.setWatchedKeys([{ zoneId: ZONE, className: 'car', threshold: 1, sustainSeconds: 5 }])

    for (let t = 0; t < 50; t += 1) watcher.observe(DEVICE, parking(1), t * SEC)

    expect(onImpossibleScope).toHaveBeenCalledTimes(1)
  })

  it('stays silent for a macro class and for the all-classes scope', () => {
    const onImpossibleScope = vi.fn<(scope: OccupancyImpossibleScope) => void>()
    const watcher = new OccupancyWatcher({ onImpossibleScope })
    watcher.setWatchedKeys([
      { zoneId: ZONE, className: 'vehicle', threshold: 1, sustainSeconds: 5 },
      { zoneId: ZONE, threshold: 1, sustainSeconds: 5 },
    ])

    watcher.observe(DEVICE, parking(1), 0)

    expect(onImpossibleScope).not.toHaveBeenCalled()
  })

  it('re-reports after the operator edits the rule — a new key is a new answer', () => {
    const onImpossibleScope = vi.fn<(scope: OccupancyImpossibleScope) => void>()
    const watcher = new OccupancyWatcher({ onImpossibleScope })
    watcher.setWatchedKeys([{ zoneId: ZONE, className: 'car', threshold: 1, sustainSeconds: 5 }])
    watcher.observe(DEVICE, parking(1), 0)

    // Edited to a different threshold — still `car`, still impossible, and the
    // operator has just changed the rule: saying it again is the useful answer.
    watcher.setWatchedKeys([{ zoneId: ZONE, className: 'car', threshold: 2, sustainSeconds: 5 }])
    watcher.observe(DEVICE, parking(1), SEC)

    expect(onImpossibleScope).toHaveBeenCalledTimes(2)
  })

  it('is optional — a watcher with no reporter behaves identically', () => {
    const watcher = watcherForParking('car')
    expect(() => watcher.observe(DEVICE, parking(1), 0)).not.toThrow()
  })
})
