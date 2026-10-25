/**
 * A CENSUS sample testifies to a PRESENCE. It can never testify to an absence.
 *
 * Measured on device 102, zone "Parking pat'", 2026-09-15. Three false
 * "Pat è andato via" in twelve minutes — 17:23:15, 17:30:51, 17:35:15 — on a
 * car that never moved. Two of them were contradicted by a "Pat è tornato"
 * 46 s and 30 s later.
 *
 * The proof of WHO armed them is in the timestamps: the three edges carry
 * `observedAt` 1789485735544 / 1789486215545 / 1789486455546 — exactly 420 000
 * and 240 000 ms apart, all landing on `:15.545`. That is one `setInterval`:
 * `ZoneAnalyticsProvider.appendBaselineSamples`, which every 60 s builds a
 * snapshot from the STATIONARY CENSUS ALONE and hands it to this watcher
 * through the same `emitSnapshot` a real frame uses. No detector looked.
 *
 * The sampler exists so a detached-but-occupied camera keeps its occupancy
 * confirmed — true for a car that IS censused, exactly inverted for one that is
 * not. The car in this zone is not censused and cannot be: its box is ~35 % of
 * the frame and the birth bar (D497) is 30 %.
 *
 * So the census read "0 vehicles" and the zone believed it. But a census entry
 * only ever retires on a FRAME — on observed strikes (D279) or on observed time
 * (D501). A census that answers 0 is not saying "the spot is empty"; it is
 * saying "nothing here is censused", which is **`null`, not zero** (D393).
 *
 * Hence the rule pinned here: a census sample may CONFIRM an occupancy and may
 * cancel a pending departure, and it may do nothing else. The departure of a
 * real car is untouched — it arrives as scene samples, which is what a camera
 * that just saw a car drive away produces.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { CameraOccupancySnapshot } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import { OccupancyWatcher } from '../occupancy-watcher.js'

const DEVICE = 102
const ZONE = 'parking-pat'
const SEC = 1_000

function snap(vehicles: number, ts: number): CameraOccupancySnapshot {
  const ids = Array.from({ length: vehicles }, (_, i) => `car-${String(i)}`)
  return {
    ts,
    frameWidth: 3840,
    frameHeight: 2160,
    frame: { totalObjects: vehicles, byClass: { vehicle: vehicles }, trackIds: ids },
    zones: [
      {
        zoneId: ZONE,
        zoneName: "Parking pat'",
        totalObjects: vehicles,
        byClass: { vehicle: vehicles },
        trackIds: ids,
      },
    ],
  } as unknown as CameraOccupancySnapshot
}

function watcher(): OccupancyWatcher {
  const w = new OccupancyWatcher()
  w.setWatchedKeys([{ zoneId: ZONE, className: 'vehicle', threshold: 1, sustainSeconds: 29 }])
  return w
}

describe('a census sample cannot witness an absence', () => {
  // THE MEASURED CASE. Two census ticks, 60 s apart, both reading zero — which
  // on 102 is what produced the operator's false alert.
  it('two census ticks reading zero commit NOTHING', () => {
    const w = watcher()
    // The scene saw the car: that is a real observation and it seeds occupied.
    expect(w.observe(DEVICE, snap(1, 0), 0, 'scene')).toEqual([])
    expect(w.observe(DEVICE, snap(0, 60 * SEC), 60 * SEC, 'census')).toEqual([])
    // 60 s later — well past `sustainSeconds: 29` — the second tick agrees with
    // the first. Before the fix this is the line that fired.
    expect(w.observe(DEVICE, snap(0, 120 * SEC), 120 * SEC, 'census')).toEqual([])
  })

  // THE CONTROL, and the whole point of the feature: a car that really leaves
  // must still be announced. A camera that just watched one drive away is
  // producing SCENE samples, so nothing about that path changes.
  it('a real departure, seen by the scene, still commits', () => {
    const w = watcher()
    w.observe(DEVICE, snap(1, 0), 0, 'scene')
    expect(w.observe(DEVICE, snap(0, 1 * SEC), 1 * SEC, 'scene')).toEqual([])
    const edges = w.observe(DEVICE, snap(0, 31 * SEC), 31 * SEC, 'scene')
    expect(edges).toHaveLength(1)
    expect(edges[0]?.occupied).toBe(false)
  })

  // A census that SEES something is a real observation of a presence, and it
  // is the reason the sampler exists: a detached-but-occupied camera keeps its
  // occupancy confirmed instead of ageing out.
  it('a census that SEES the car cancels a departure armed by the scene', () => {
    const w = watcher()
    w.observe(DEVICE, snap(1, 0), 0, 'scene')
    w.observe(DEVICE, snap(0, 1 * SEC), 1 * SEC, 'scene') // arms the departure
    w.observe(DEVICE, snap(1, 10 * SEC), 10 * SEC, 'census') // …and cancels it
    // Past the sustain window: had the cancel not landed, this would commit.
    expect(w.observe(DEVICE, snap(1, 40 * SEC), 40 * SEC, 'census')).toEqual([])
  })

  // A key nobody has ever observed must not be BORN empty from a census. The
  // seed is a level, and a level invented from "nothing is censused" makes the
  // first real frame look like an arrival that never happened.
  it('a cold key is not seeded by a census reading zero', () => {
    const w = watcher()
    expect(w.observe(DEVICE, snap(0, 0), 0, 'census')).toEqual([])
    expect(w.takeSeededRows()).toHaveLength(0)
    // The first SCENE sample is what establishes the level…
    expect(w.observe(DEVICE, snap(1, SEC), SEC, 'scene')).toEqual([])
    expect(w.takeSeededRows()).toHaveLength(1)
  })

  // …but a census that SEES something may seed, because that is an observation.
  it('a cold key CAN be seeded by a census that sees the car', () => {
    const w = watcher()
    expect(w.observe(DEVICE, snap(1, 0), 0, 'census')).toEqual([])
    expect(w.takeSeededRows()).toHaveLength(1)
  })
})

/**
 * The rule above is worth nothing if the two producers are labelled the wrong
 * way round, and that is a silent failure: both literals type-check, both
 * compile, and the fleet keeps firing false departures. TypeScript guarantees
 * the argument is PASSED; only this says it is the right one.
 */
describe('the two producers are labelled at their own call sites', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'pipeline-analytics', 'zone-analytics-provider.ts'),
    'utf8',
  )

  it('a real frame emits `scene`', () => {
    const frame = source.slice(source.indexOf('  async recordFrame('))
    const emit = frame.slice(frame.indexOf('this.emitSnapshot('))
    expect(emit.slice(0, 120)).toContain("'scene'")
  })

  it('the stationary baseline sampler emits `census`', () => {
    const sampler = source.slice(source.indexOf('private async appendBaselineSamples('))
    const emit = sampler.slice(sampler.indexOf('this.emitSnapshot('))
    expect(emit.slice(0, 120)).toContain("'census'")
  })

  // Neither may go out unlabelled: the default is `scene`, so an omitted
  // argument at the sampler would restore exactly the defect.
  it('no emit is left unlabelled', () => {
    const calls = source.match(/this\.emitSnapshot\([^)]*\)/gs) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const call of calls) {
      expect(call).toMatch(/'scene'|'census'|evidence/)
    }
  })
})
